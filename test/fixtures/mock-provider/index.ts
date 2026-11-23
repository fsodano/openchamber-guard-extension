/**
 * Mock provider plugin (test fixture only, not shipped).
 *
 * Registers one OpenAI-compatible provider that points at a local mock server (`options.baseURL`). The guard plugin
 * has no provider of its own, so the integration tests need a model that a deterministic fake server can script.
 */

interface MockProviderOptions {
  baseURL: string
  providerID: string
  modelID: string
}

const plugin = {
  id: "mock-provider",
  async setup(ctx: any) {
    const options = ctx.options as unknown as MockProviderOptions
    await ctx.provider.transform((editor: any) => {
      editor.add({
        info: {
          id: options.providerID,
          integrationID: options.providerID,
          name: "Mock provider",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: options.baseURL, apiKey: "sk-test-not-a-real-key" },
        },
        models: [
          {
            id: options.modelID,
            modelID: options.modelID,
            providerID: options.providerID,
            name: "Mock model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 32_000 },
          },
        ],
      })
    })
    return async () => {}
  },
}

export default plugin
