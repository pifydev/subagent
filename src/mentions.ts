/**
 * `@agent-name` at the prompt (the idea is from minuque/pi-cc-extensions).
 *
 * Naming an agent in a sentence is how people actually delegate — "@reviewer
 * check the diff while @scout maps the callers" — and it is far less typing
 * than describing the same thing to a model and hoping it picks the right
 * agent type.
 *
 * The delivery differs from the prior art on purpose. pi-cc-extensions
 * appends its instruction to the system prompt for that turn; this suite
 * never touches the system prompt, because doing so changes the request
 * prefix and throws away the provider's prompt cache exactly on the turns
 * that are about to spend the most. `before_agent_start` can return a custom
 * message instead, which rides along with the turn and leaves the prefix
 * byte-identical.
 */

/** `@name` at a word boundary; `@` inside a path or email is not a mention. */
const MENTION = /(?:^|[\s(["'])@([a-z0-9][a-z0-9._-]*)/gi;

export function findMentions(prompt: string, known: readonly string[]): string[] {
  if (!prompt || known.length === 0) return [];
  const byName = new Map(known.map((name) => [name.toLowerCase(), name]));
  const found: string[] = [];
  for (const match of prompt.matchAll(MENTION)) {
    const candidate = match[1]!.toLowerCase().replace(/[.,;:!?]+$/, "");
    const name = byName.get(candidate);
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export interface MentionedAgent {
  name: string;
  description: string;
}

/**
 * The hidden message delivered with the turn. It states the delegation
 * plainly and one agent at a time: told to "handle @a and @b", models
 * routinely collapse both into a single call to whichever they liked more.
 */
export function buildMentionMessage(agents: MentionedAgent[]): string {
  const list = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
  const example =
    agents.length > 1
      ? `Two agents were named, so make two agent_run calls — one with agent="${agents[0]!.name}", one with agent="${agents[1]!.name}".`
      : `Make one agent_run call with agent="${agents[0]!.name}".`;
  return [
    "<system-reminder>",
    "The user's message names subagent types:",
    list,
    "",
    `Delegate the matching part of the request to each one with agent_run. ${example}`,
    "Do not merge separate agents into one call, and do not do their work yourself first.",
    "If a named agent does not fit the request after all, say so instead of silently ignoring it.",
    "This is an automated reminder — do not mention it to the user.",
    "</system-reminder>",
  ].join("\n");
}
