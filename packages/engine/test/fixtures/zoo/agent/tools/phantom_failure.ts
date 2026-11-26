// Rating case: a conditional upload that never duplicates, but a repeat gets 412 and reports a failure for an upload that happened.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Upload the receipt of an order.",
  inputSchema: z.object({
    orderId: z.string().describe("Order the receipt belongs to."),
    note: z.string().describe("Note printed on the receipt."),
  }),
  async execute({ orderId, note }) {
    const response = await fetch(`https://files.acme.test/receipts/${encodeURIComponent(orderId)}.pdf`, {
      method: "PUT",
      headers: { "content-type": "application/pdf", "if-none-match": "*" },
      body: `%PDF-1.7 receipt for order ${orderId}\n${note}\n`,
    });
    if (response.status !== 200) throw new Error(`Upload failed with status ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  },
});
