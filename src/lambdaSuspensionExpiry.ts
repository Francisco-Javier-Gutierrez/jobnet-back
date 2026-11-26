import { handleSuspensionExpiry } from "./handlers/moderator/suspensions";

export const handler = async (event: any) => {
  console.log(
    "[DynamoDB Stream Trigger] Processing suspension expiry events:",
    JSON.stringify(event, null, 2),
  );
  return handleSuspensionExpiry(event);
};

export default handler;
