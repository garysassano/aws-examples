import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

// The `tableName` of the DynamoDB table in the stack. A batch write has to name its table.
const TABLE = "events-table";

export const onPublish = {
  request(ctx) {
    const channel = ctx.info.channel.path;
    const timestamp = util.time.nowISO8601();
    return ddb.batchPut({
      tables: {
        // The payload stays in its own attribute, so its fields can't overwrite the item's key and
        // it doesn't have to be an object.
        [TABLE]: ctx.events.map(({ id, payload }) => ({
          id,
          type: "publish",
          channel,
          timestamp,
          payload,
        })),
      },
    });
  },
  response(ctx) {
    if (ctx.error) {
      util.error(ctx.error.message, ctx.error.type);
    }
    // Subscribers receive only the events that this returns.
    return ctx.result.data[TABLE].map(({ id, payload }) => ({ id, payload }));
  },
};

export const onSubscribe = {
  request(ctx) {
    return ddb.put({
      key: { id: util.autoId() },
      item: {
        type: "subscribe",
        channel: ctx.info.channel.path,
        timestamp: util.time.nowISO8601(),
      },
    });
  },
  response(ctx) {
    if (ctx.error) {
      util.error(ctx.error.message, ctx.error.type);
    }
    return null;
  },
};
