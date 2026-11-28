// Rating case: a Vercel Blob put with allowOverwrite whose content carries free text; a replay with reworded text overwrites the same object.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Save a described note to the note store.",
  inputSchema: z.object({
    noteId: z.string().describe("Note that is saved."),
    description: z.string().describe("What the note says."),
  }),
  async execute({ noteId, description }) {
    // The request @vercel/blob sends for put(pathname, body, { allowOverwrite: true, contentType }).
    const params = new URLSearchParams({ pathname: `zoo/described/${noteId}.json` });
    const response = await fetch(`https://vercel.com/api/blob/?${params}`, {
      method: "PUT",
      headers: { "x-content-type": "application/json", "x-allow-overwrite": "1" },
      body: JSON.stringify({ noteId, description, updatedAt: new Date().toISOString() }),
    });
    const result = (await response.json()) as { error?: { message?: string } } & Record<string, unknown>;
    if (!response.ok) throw new Error(`Vercel Blob: ${result.error?.message ?? `status ${response.status}`}`);
    return result;
  },
});
