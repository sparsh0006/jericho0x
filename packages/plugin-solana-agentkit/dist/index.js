// src/actions/createToken.ts
import {
  composeContext,
  elizaLogger,
  generateObjectDeprecated,
  ModelClass
} from "@elizaos/core";
import { SolanaAgentKit } from "solana-agent-kit";
function isCreateTokenContent(content) {
  elizaLogger.log("Content for createToken", content);
  return typeof content.name === "string" && typeof content.uri === "string" && typeof content.symbol === "string" && typeof content.decimals === "number" && typeof content.initialSupply === "number";
}
var createTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "name": "Example Token",
    "symbol": "EXMPL",
    "uri": "https://raw.githubusercontent.com/solana-developers/opos-asset/main/assets/CompressedCoil/image.png",
    "decimals": 18,
    "initialSupply": 1000000,
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Token name
- Token symbol
- Token uri
- Token decimals
- Token initialSupply

Respond with a JSON markdown block containing only the extracted values.`;
var createToken_default = {
  name: "CREATE_TOKEN",
  similes: ["DEPLOY_TOKEN"],
  validate: async (_runtime, _message) => true,
  description: "Create tokens",
  handler: async (runtime, message, state, _options, callback) => {
    elizaLogger.log("Starting CREATE_TOKEN handler...");
    if (!state) {
      state = await runtime.composeState(message);
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    const transferContext = composeContext({
      state,
      template: createTemplate
    });
    const content = await generateObjectDeprecated({
      runtime,
      context: transferContext,
      modelClass: ModelClass.LARGE
    });
    if (!isCreateTokenContent(content)) {
      elizaLogger.error("Invalid content for CREATE_TOKEN action.");
      if (callback) {
        callback({
          text: "Unable to process create token request. Invalid content provided.",
          content: { error: "Invalid creat token content" }
        });
      }
      return false;
    }
    elizaLogger.log("Init solana agent kit...");
    const solanaPrivatekey = runtime.getSetting("SOLANA_PRIVATE_KEY");
    const rpc = runtime.getSetting("SOLANA_RPC_URL");
    const openAIKey = runtime.getSetting("OPENAI_API_KEY");
    const solanaAgentKit = new SolanaAgentKit(
      solanaPrivatekey,
      rpc,
      openAIKey
    );
    try {
      const deployedAddress = await solanaAgentKit.deployToken(
        content.name,
        content.uri,
        content.symbol,
        content.decimals
        // content.initialSupply comment out this cause the sdk has some issue with this parameter
      );
      elizaLogger.log("Create successful: ", deployedAddress);
      elizaLogger.log(deployedAddress);
      if (callback) {
        callback({
          text: `Successfully create token ${content.name}`,
          content: {
            success: true,
            deployedAddress
          }
        });
      }
      return true;
    } catch (error) {
      if (callback) {
        elizaLogger.error("Error during create token: ", error);
        callback({
          text: `Error creating token: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Create token, name is Example Token, symbol is EXMPL, uri is https://raw.githubusercontent.com/solana-developers/opos-asset/main/assets/CompressedCoil/image.png, decimals is 9, initialSupply is 100000000000"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll create token now...",
          action: "CREATE_TOKEN"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Successfully create token 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa"
        }
      }
    ]
  ]
};

// src/index.ts
var solanaAgentkitPlguin = {
  name: "solana",
  description: "Solana Plugin with solana agent kit for Eliza",
  actions: [createToken_default],
  evaluators: [],
  providers: []
};
var index_default = solanaAgentkitPlguin;
export {
  index_default as default,
  solanaAgentkitPlguin
};
//# sourceMappingURL=index.js.map