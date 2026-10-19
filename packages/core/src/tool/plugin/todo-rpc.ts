export * as TodoRpc from "./todo-rpc.js"

import { Rpc } from "@opencode/schema/rpc"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"

export const Todo = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
})
export type Todo = typeof Todo.Type

const todos = Schema.Array(Todo)

// Standard Schema views let promise clients use the same definition.
export const Definition = Rpc.define({
  id: "experimental.todo",
  methods: {
    get: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Session.ID })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean, todos })),
      errors: { unavailable: Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
  },
  events: { updated: { schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Session.ID, todos })) } },
})
