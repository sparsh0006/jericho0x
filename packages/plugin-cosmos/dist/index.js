// src/actions/transfer/index.ts
import {
  composeContext,
  generateObjectDeprecated,
  ModelClass
} from "@elizaos/core";

// src/shared/entities/cosmos-wallet-chains-data.ts
import { getChainByChainName } from "@chain-registry/utils";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { chains } from "chain-registry";

// src/shared/entities/cosmos-wallet.ts
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { cosmos } from "interchain";
var CosmosWallet = class _CosmosWallet {
  rpcQueryClient;
  directSecp256k1HdWallet;
  constructor(directSecp256k1HdWallet, rpcQueryClient) {
    this.directSecp256k1HdWallet = directSecp256k1HdWallet;
    this.rpcQueryClient = rpcQueryClient;
  }
  static async create(mnemonic, chainPrefix, rpcEndpoint) {
    const directSecp256k1HdWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: chainPrefix
    });
    const rpcQueryClient = await cosmos.ClientFactory.createRPCQueryClient({
      rpcEndpoint
    });
    return new _CosmosWallet(directSecp256k1HdWallet, rpcQueryClient);
  }
  async getWalletAddress() {
    const [account] = await this.directSecp256k1HdWallet.getAccounts();
    return account.address;
  }
  async getWalletBalances() {
    const walletAddress = await this.getWalletAddress();
    const allBalances = await this.rpcQueryClient.cosmos.bank.v1beta1.allBalances({
      address: walletAddress
    });
    return allBalances.balances;
  }
};

// src/shared/helpers/cosmos-chains.ts
var getAvailableChains = (chains2, customChains) => [
  ...chains2?.filter(
    (chain) => !(customChains ?? [])?.map((customChain) => customChain.chain_name)?.includes(chain.chain_name)
  ) ?? [],
  ...customChains ?? []
];

// src/shared/entities/cosmos-wallet-chains-data.ts
var CosmosWalletChains = class _CosmosWalletChains {
  walletChainsData = {};
  constructor(walletChainsData) {
    this.walletChainsData = walletChainsData;
  }
  static async create(mnemonic, availableChainNames, customChainsData) {
    const walletChainsData = {};
    const availableChains = getAvailableChains(chains, customChainsData);
    for (const chainName of availableChainNames) {
      const chain = getChainByChainName(availableChains, chainName);
      if (!chain) {
        throw new Error(`Chain ${chainName} not found`);
      }
      const wallet = await CosmosWallet.create(
        mnemonic,
        chain.bech32_prefix,
        chain.apis.rpc[0].address
      );
      const chainRpcAddress = chain.apis?.rpc?.[0].address;
      if (!chainRpcAddress) {
        throw new Error(`RPC address not found for chain ${chainName}`);
      }
      const signingCosmWasmClient = await SigningCosmWasmClient.connectWithSigner(
        chain.apis.rpc[0].address,
        wallet.directSecp256k1HdWallet
      );
      walletChainsData[chainName] = {
        wallet,
        signingCosmWasmClient
      };
    }
    return new _CosmosWalletChains(walletChainsData);
  }
  async getWalletAddress(chainName) {
    return await this.walletChainsData[chainName].wallet.getWalletAddress();
  }
  getSigningCosmWasmClient(chainName) {
    return this.walletChainsData[chainName].signingCosmWasmClient;
  }
};

// src/providers/wallet/utils.ts
var initWalletChainsData = async (runtime) => {
  const mnemonic = runtime.getSetting("COSMOS_RECOVERY_PHRASE");
  const availableChains = runtime.getSetting("COSMOS_AVAILABLE_CHAINS");
  if (!mnemonic) {
    throw new Error("COSMOS_RECOVERY_PHRASE is missing");
  }
  if (!availableChains) {
    throw new Error("COSMOS_AVAILABLE_CHAINS is missing");
  }
  const availableChainsArray = availableChains.split(",");
  if (!availableChainsArray.length) {
    throw new Error("COSMOS_AVAILABLE_CHAINS is empty");
  }
  return await CosmosWalletChains.create(mnemonic, availableChainsArray);
};

// src/templates/index.ts
var cosmosTransferTemplate = `Given the recent messages and cosmos wallet information below:
{{recentMessages}}
{{walletInfo}}
Extract the following information about the requested transfer:
1. **Amount**:
   - Extract only the numeric value from the instruction.
   - The value must be a string representing the amount in the display denomination (e.g., "0.0001" for OM, chimba, etc.). Do not include the symbol.

2. **Recipient Address**:
   - Must be a valid Bech32 address that matches the chain's address prefix.
   - Example for "mantra": "mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf".

3. **Token Symbol**:
   - The symbol must be a string representing the token's display denomination (e.g., "OM", "chimba", etc.).

4. **Chain name**:
   - Identify the chain mentioned in the instruction where the transfer will take place (e.g., carbon, axelar, mantrachaintestnet2).
   - Provide this as a string.

Respond with a JSON markdown block containing only the extracted values. All fields except 'token' are required:
\`\`\`json
{
    "symbol": string, // The symbol of token.
    "amount": string, // The amount to transfer as a string.
    "toAddress": string, // The recipient's address.
    "chainName": string // The chain name.
\`\`\`

Example reponse for the input: "Make transfer 0.0001 OM to mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf on mantrachaintestnet2", the response should be:
\`\`\`json
{
    "symbol": "OM",
    "amount": "0.0001",
    "toAddress": "mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf",
    "chainName": "mantrachaintestnet2"
\`\`\`

Now respond with a JSON markdown block containing only the extracted values.
`;

// src/actions/transfer/services/cosmos-transfer-action-service.ts
import {
  convertDisplayUnitToBaseUnit,
  getAssetBySymbol
} from "@chain-registry/utils";
import { assets } from "chain-registry";

// src/shared/helpers/cosmos-transaction-receipt.ts
var DEFUALT_EVENTS = [
  { eventName: "fee_pay", attributeType: "fee" },
  { eventName: "tip_refund", attributeType: "tip" }
];
var getPaidFeeFromReceipt = (receipt, eventsToPickGasFor = DEFUALT_EVENTS) => {
  const selectedEvents = receipt.events.filter(
    ({ type }) => eventsToPickGasFor.map(({ eventName }) => eventName).includes(type)
  );
  return selectedEvents.reduce((acc, { attributes }) => {
    return acc + attributes.reduce((_acc, { key, value }) => {
      if (eventsToPickGasFor.some(
        ({ attributeType }) => attributeType === key
      )) {
        const testValue = value.match(/\d+/)?.[0];
        const testValueAsNumber = Number(testValue);
        if (Number.isNaN(testValueAsNumber)) {
          return _acc;
        }
        _acc = _acc + testValueAsNumber;
        return _acc;
      }
      return _acc;
    }, 0);
  }, 0);
};

// src/shared/services/cosmos-transaction-fee-estimator.ts
var CosmosTransactionFeeEstimator = class {
  static async estimateGasForTransaction(signingCosmWasmClient, senderAddress, message, memo = "") {
    const estimatedGas = await signingCosmWasmClient.simulate(
      senderAddress,
      message,
      memo
    );
    const safeEstimatedGas = Math.ceil(estimatedGas * 1.2);
    return safeEstimatedGas;
  }
  static estimateGasForCoinTransfer(signingCosmWasmClient, senderAddress, recipientAddress, amount, memo = "") {
    return this.estimateGasForTransaction(
      signingCosmWasmClient,
      senderAddress,
      [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: {
            fromAddress: senderAddress,
            toAddress: recipientAddress,
            amount: [...amount]
          }
        }
      ],
      memo
    );
  }
};

// src/shared/helpers/cosmos-assets.ts
var getAvailableAssets = (assets3, customAssets) => {
  const result = [];
  const safeAssets = assets3 || [];
  const safeCustomAssets = customAssets || [];
  const customChainNames = new Set(
    safeCustomAssets.map((asset) => asset.chain_name)
  );
  for (const asset of safeAssets) {
    if (!customChainNames.has(asset.chain_name)) {
      result.push(asset);
    }
  }
  result.push(...safeCustomAssets);
  return result;
};

// src/actions/transfer/services/cosmos-transfer-action-service.ts
var CosmosTransferActionService = class {
  constructor(cosmosWalletChains) {
    this.cosmosWalletChains = cosmosWalletChains;
    this.cosmosWalletChains = cosmosWalletChains;
  }
  async execute(params, customChainAssets) {
    const signingCosmWasmClient = this.cosmosWalletChains.getSigningCosmWasmClient(params.chainName);
    const senderAddress = await this.cosmosWalletChains.getWalletAddress(
      params.chainName
    );
    if (!senderAddress) {
      throw new Error(
        `Cannot get wallet address for chain ${params.chainName}`
      );
    }
    if (!params.toAddress) {
      throw new Error("No receiver address");
    }
    if (!params.symbol) {
      throw new Error("No symbol");
    }
    const availableAssets = getAvailableAssets(assets, customChainAssets);
    const coin = {
      denom: getAssetBySymbol(
        availableAssets,
        params.symbol,
        params.chainName
      ).base,
      amount: convertDisplayUnitToBaseUnit(
        availableAssets,
        params.symbol,
        params.amount,
        params.chainName
      )
    };
    const gasFee = await CosmosTransactionFeeEstimator.estimateGasForCoinTransfer(
      signingCosmWasmClient,
      senderAddress,
      params.toAddress,
      [coin]
    );
    const txDeliveryResponse = await signingCosmWasmClient.sendTokens(
      senderAddress,
      params.toAddress,
      [coin],
      { gas: gasFee.toString(), amount: [{ ...coin, amount: gasFee.toString() }] }
    );
    const gasPaid = getPaidFeeFromReceipt(txDeliveryResponse);
    return {
      from: senderAddress,
      to: params.toAddress,
      gasPaid,
      txHash: txDeliveryResponse.transactionHash
    };
  }
};

// src/actions/transfer/index.ts
var createTransferAction = (pluginOptions) => ({
  name: "COSMOS_TRANSFER",
  description: "Transfer tokens between addresses on the same chain",
  handler: async (_runtime, _message, state, _options, _callback) => {
    const cosmosTransferContext = composeContext({
      state,
      template: cosmosTransferTemplate,
      templatingEngine: "handlebars"
    });
    const cosmosTransferContent = await generateObjectDeprecated({
      runtime: _runtime,
      context: cosmosTransferContext,
      modelClass: ModelClass.SMALL
    });
    const paramOptions = {
      chainName: cosmosTransferContent.chainName,
      symbol: cosmosTransferContent.symbol,
      amount: cosmosTransferContent.amount,
      toAddress: cosmosTransferContent.toAddress
    };
    try {
      const walletProvider = await initWalletChainsData(_runtime);
      const action = new CosmosTransferActionService(walletProvider);
      const customAssets = (pluginOptions?.customChainData ?? []).map(
        (chainData) => chainData.assets
      );
      const transferResp = await action.execute(
        paramOptions,
        customAssets
      );
      if (_callback) {
        await _callback({
          text: `Successfully transferred ${paramOptions.amount} tokens to ${paramOptions.toAddress}
Gas paid: ${transferResp.gasPaid}
Transaction Hash: ${transferResp.txHash}`,
          content: {
            success: true,
            hash: transferResp.txHash,
            amount: paramOptions.amount,
            recipient: transferResp.to,
            chain: cosmosTransferContent.fromChain
          }
        });
        const newMemory = {
          userId: _message.agentId,
          agentId: _message.agentId,
          roomId: _message.roomId,
          content: {
            text: `Transaction ${paramOptions.amount} ${paramOptions.symbol} to address ${paramOptions.toAddress} on chain ${paramOptions.toAddress} was successfully transfered.
 Gas paid: ${transferResp.gasPaid}. Tx hash: ${transferResp.txHash}`
          }
        };
        await _runtime.messageManager.createMemory(newMemory);
      }
      return true;
    } catch (error) {
      console.error("Error during token transfer:", error);
      if (_callback) {
        await _callback({
          text: `Error transferring tokens: ${error.message}`,
          content: { error: error.message }
        });
      }
      const newMemory = {
        userId: _message.agentId,
        agentId: _message.agentId,
        roomId: _message.roomId,
        content: {
          text: `Transaction ${paramOptions.amount} ${paramOptions.symbol} to address ${paramOptions.toAddress} on chain ${paramOptions.toAddress} was unsuccessful.`
        }
      };
      await _runtime.messageManager.createMemory(newMemory);
      return false;
    }
  },
  template: cosmosTransferTemplate,
  validate: async (runtime) => {
    const mnemonic = runtime.getSetting("COSMOS_RECOVERY_PHRASE");
    const availableChains = runtime.getSetting("COSMOS_AVAILABLE_CHAINS");
    const availableChainsArray = availableChains?.split(",");
    return !(mnemonic && availableChains && availableChainsArray.length);
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Make transfer {{0.0001 OM}} to {{mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf}} on {{mantrachaintestnet2}}",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Do you confirm the transfer action?",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user1}}",
        content: {
          text: "Yes",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "",
          action: "COSMOS_TRANSFER"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Send {{10 OSMO}} to {{osmo13248w8dtnn07sxc3gq4l3ts4rvfyat6f4qkdd6}} on {{osmosistestnet}}",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Do you confirm the transfer action?",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user1}}",
        content: {
          text: "Yes",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "",
          action: "COSMOS_TRANSFER"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Send {{0.0001 OM}} on {{mantrachaintestnet2}} to {{mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf}}.",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Do you confirm the transfer action?",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user1}}",
        content: {
          text: "Yes",
          action: "COSMOS_TRANSFER"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "",
          action: "COSMOS_TRANSFER"
        }
      }
    ]
  ],
  similes: [
    "COSMOS_SEND_TOKENS",
    "COSMOS_TOKEN_TRANSFER",
    "COSMOS_MOVE_TOKENS"
  ]
});

// src/providers/wallet/index.ts
import {
  convertBaseUnitToDisplayUnit,
  getSymbolByDenom
} from "@chain-registry/utils";
import { assets as assets2 } from "chain-registry";
var createCosmosWalletProvider = (pluginOptions) => ({
  get: async (runtime) => {
    let providerContextMessage = "";
    const customAssets = (pluginOptions?.customChainData ?? []).map(
      (chainData) => chainData.assets
    );
    const availableAssets = getAvailableAssets(assets2, customAssets);
    try {
      const provider = await initWalletChainsData(runtime);
      for (const [chainName, { wallet }] of Object.entries(
        provider.walletChainsData
      )) {
        const address = await wallet.getWalletAddress();
        const balances = await wallet.getWalletBalances();
        const convertedCoinsToDisplayDenom = balances.map((balance) => {
          const symbol = getSymbolByDenom(
            availableAssets,
            balance.denom,
            chainName
          );
          return {
            amount: symbol ? convertBaseUnitToDisplayUnit(
              availableAssets,
              symbol,
              balance.amount,
              chainName
            ) : balance.amount,
            symbol: symbol ?? balance.denom
          };
        });
        const balancesToString = convertedCoinsToDisplayDenom.map((balance) => `- ${balance.amount} ${balance.symbol}`).join("\n");
        providerContextMessage += `Chain: ${chainName}
Address: ${address}
Balances:
${balancesToString}
________________
`;
      }
      return providerContextMessage;
    } catch (error) {
      console.error(
        "Error Initializing in Cosmos wallet provider:",
        error
      );
      return null;
    }
  }
});

// src/index.ts
var createCosmosPlugin = (pluginOptions) => ({
  name: "cosmos",
  description: "Cosmos blockchain integration plugin",
  providers: [createCosmosWalletProvider(pluginOptions)],
  evaluators: [],
  services: [],
  actions: [createTransferAction(pluginOptions)]
});
var index_default = createCosmosPlugin;
export {
  createCosmosPlugin,
  index_default as default
};
//# sourceMappingURL=index.js.map