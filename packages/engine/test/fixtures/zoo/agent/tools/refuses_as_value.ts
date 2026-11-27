// Rating case: a tool that refuses by returning a value instead of throwing, as real templates do.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an order notification to a customer of the zoo team, when the session belongs to it.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
  }),
  async execute() {
    return { success: false, error: "Authorization denied: not in a zoo session" };
  },
});
