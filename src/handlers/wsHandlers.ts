export const connect = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  console.log(`Connection established: ${connectionId}`);
  // In a real app, save this connection ID to DynamoDB with the user ID from the authorizer
  return { statusCode: 200, body: 'Connected' };
};

export const disconnect = async (event: any) => {
  const connectionId = event.requestContext.connectionId;
  console.log(`Connection closed: ${connectionId}`);
  // In a real app, remove this connection ID from DynamoDB
  return { statusCode: 200, body: 'Disconnected' };
};

export const defaultRoute = async (event: any) => {
  console.log(`Default route hit: ${event.requestContext.connectionId}`);
  return { statusCode: 200, body: 'Default route' };
};
