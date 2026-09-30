import { Effect, Schema } from "effect"
import { PositiveInt, NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundShell } from "@/background/shell"
import { Tool } from "./tool"
import { ToolJsonSchema } from "./json-schema"
import GUIDE from "./shell/background.txt"

const Job = Schema.Struct({
  job_id: Schema.String.annotate({ description: "The job ID returned by a background bash call or shell_list" }),
})
const OutputParameters = Schema.Struct({
  ...Job.fields,
  stream: Schema.optional(Schema.Literals(["all", "stdout", "stderr"])),
  query: Schema.optional(Schema.String),
  offset: Schema.optional(PositiveInt).annotate({
    description: "First source line to consider (1-based); use nextOffset to continue",
  }),
  limit: Schema.optional(PositiveInt).annotate({ description: "Maximum matching lines, default 200, capped at 1000" }),
  wait_ms: Schema.optional(NonNegativeInt).annotate({
    description: "Wait for completion before reading, capped at 30000 ms; default 0",
  }),
})
const InputParameters = Schema.Struct({
  ...Job.fields,
  text: Schema.optional(Schema.String),
  eof: Schema.optional(Schema.Boolean),
})

export const ShellManagementTools = Effect.gen(function* () {
  const shells = yield* BackgroundShell.Service
  const list = yield* Tool.define(
    "shell_list",
    Effect.succeed({
      description:
        "List background shell jobs owned by this session or its descendants, including status, exit code, stdin availability, and searchable log paths.",
      parameters: Schema.Struct({}),
      execute: (_, ctx) =>
        Effect.gen(function* () {
          const jobs = yield* shells.list(ctx.sessionID)
          return {
            title: "Shell jobs",
            output: JSON.stringify(
              jobs.map((job) => ({ ...job, output: undefined })),
              null,
              2,
            ),
            metadata: { count: jobs.length },
          }
        }),
    }),
  )
  const output = yield* Tool.define(
    "shell_output",
    Effect.succeed({
      description:
        "Read or search a background shell's saved output. query is a case-insensitive substring search across the entire selected log. Returns bounded numbered lines, live status, nextOffset, and log paths. Optionally wait up to 30 seconds for completion. Logs remain available after exit/cancellation.",
      parameters: OutputParameters,
      execute: (params: Schema.Schema.Type<typeof OutputParameters>, ctx) =>
        Effect.gen(function* () {
          const result = yield* shells
            .output({ ...params, id: params.job_id, sessionID: ctx.sessionID, wait: params.wait_ms })
            .pipe(Effect.orDie)
          return {
            title: `Shell output: ${params.job_id}`,
            output: JSON.stringify({ ...result, info: { ...result.info, output: undefined } }, null, 2),
            metadata: { jobId: params.job_id, outputPath: result.path },
          }
        }),
    }),
  )
  const input = yield* Tool.define(
    "shell_input",
    Effect.succeed({
      description:
        "Send exact text to an open background shell stdin pipe, optionally closing it with EOF. Include newline for line-based input. Requires a job launched with stdin=true. Does not provide terminal/PTY input. Maximum 64 KiB per call.",
      parameters: InputParameters,
      execute: (params: Schema.Schema.Type<typeof InputParameters>, ctx) =>
        Effect.gen(function* () {
          const info = yield* shells.get(ctx.sessionID, params.job_id).pipe(Effect.orDie)
          yield* ctx.ask({
            permission: "bash",
            patterns: [info.command],
            always: [],
            metadata: { jobId: info.id, input: params.text ?? "", eof: params.eof ?? false },
          })
          const result = yield* shells
            .input(ctx.sessionID, params.job_id, params.text ?? "", params.eof)
            .pipe(Effect.orDie)
          return {
            title: `Shell input: ${params.job_id}`,
            output: JSON.stringify({ id: result.id, stdinOpen: result.stdinOpen, status: result.status }),
            metadata: { jobId: result.id },
          }
        }),
    }),
  )
  const stop = yield* Tool.define(
    "shell_stop",
    Effect.succeed({
      description:
        "Terminate a background shell and its process group. Retains already-written stdout/stderr logs for inspection. Repeated stopping of an exited job is harmless.",
      parameters: Job,
      execute: (params: Schema.Schema.Type<typeof Job>, ctx) =>
        Effect.gen(function* () {
          const result = yield* shells.cancel(ctx.sessionID, params.job_id).pipe(Effect.orDie)
          return {
            title: `Stop shell: ${params.job_id}`,
            output: JSON.stringify(result, null, 2),
            metadata: { jobId: result.id },
          }
        }),
    }),
  )
  const management: Tool.Info[] = [list, output, input, stop]
  const resource = yield* Tool.define(
    "shell_tools",
    Effect.succeed({
      description:
        "Load the background-shell workflow resource and tool schemas. Call this to learn how to monitor long builds/tests/servers, search stdout/stderr logs, send stdin/EOF, or stop background shell jobs. Follow-up tools become available on the next model turn for this user request.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const tools = yield* Effect.forEach(management, (tool) => Tool.init(tool))
          return {
            title: "Background shell resource",
            output:
              GUIDE +
              "\n\n## Available tools\n\n" +
              JSON.stringify(
                tools.map((tool) => ({
                  name: tool.id,
                  description: tool.description,
                  parameters: ToolJsonSchema.fromTool(tool),
                })),
                null,
                2,
              ),
            metadata: { shellManagement: true, resource: "opencode://tools/background-shells" },
          }
        }),
    }),
  )
  const tools: Tool.Info[] = [resource, ...management]
  return tools
})

export function shellManagementRequested(messages: SessionV1.WithParts[]) {
  const index = messages.findLastIndex((message) => message.info.role === "user")
  if (index < 0) return false
  const user = messages[index].info
  return messages
    .slice(index + 1)
    .some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === user.id &&
        message.info.sessionID === user.sessionID &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "shell_tools" &&
            part.state.status === "completed" &&
            part.state.metadata.shellManagement === true,
        ),
    )
}
