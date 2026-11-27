// Rating case: a Vercel Blob put with the default options; a replay is refused after the first upload happened.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Save a note to the note store.",
  inputSchema: z.object({
    noteId: z.string().describe("Note that is saved."),
  }),
  async execute({ noteId }) {
    // The request @vercel/blob sends for put(pathname, body, { contentType }).
    const params = new URLSearchParams({ pathname: `zoo/notes/${noteId}.json` });
    const response = await fetch(`https://vercel.com/api/blob/?${params}`, {
      method: "PUT",
      headers: { "x-content-type": "application/json" },
      body: JSON.stringify({ noteId, updatedAt: new Date().toISOString() }),
    });
    const result = (await response.json()) as { error?: { message?: string } } & Record<string, unknown>;
    if (!response.ok) throw new Error(`Vercel Blob: ${result.error?.message ?? `status ${response.status}`}`);
    return result;
  },
});
