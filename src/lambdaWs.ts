import { connect, disconnect, defaultRoute, sendMessage } from "./handlers/wsHandlers";

export const handler = async (event: any, context?: any) => {
  const routeKey = event?.requestContext?.routeKey;
  console.log(
    `[WebSocket Router] Handling routeKey: ${routeKey}, connectionId: ${event?.requestContext?.connectionId}`,
  );

  switch (routeKey) {
    case "$connect":
      return await (connect as any)(event, context);
    case "$disconnect":
      return await (disconnect as any)(event, context);
    case "sendMessage":
      return await sendMessage(event);
    case "$default":
    default:
      return await (defaultRoute as any)(event, context);
  }
};

export default handler;
