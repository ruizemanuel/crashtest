// The `effects.ignore` rule of the configuration, in one place for both of its users: detection leaves an ignored
// ledger entry out when it counts effects, and the preload never lets an ignored request or file write claim the
// crash point. Pure: loaded inside the agent's own process too.

/** A glob where `*` matches any run of characters and everything else is literal; it must match the whole text. */
function globToRegExp(glob: string): RegExp {
  const literal = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${glob.split("*").map(literal).join(".*")}$`, "s");
}

/**
 * Whether a ledger `url` (the redacted URL of a request, or the lab-relative posix path of a file write) is one the
 * globs say is not an effect of the tool.
 */
export function ignoreMatcher(globs: readonly string[]): (url: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (url) => patterns.some((pattern) => pattern.test(url));
}
