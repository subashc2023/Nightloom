// Item 767: the door — chats started and messaged from outside the app
// (`nightloom chat …`, `mcp-serve --outside`). The pure parts: the mark's
// words and the Settings card's.

/** What Settings → Outside control reads (`door_card`). */
export interface DoorCard {
  /** Outside callers may start and message chats. */
  writes: boolean;
  /** The socket this app listens on; null when it is not listening. */
  socket: string | null;
  /** This app's binary as the command (`… --chat`). */
  command: string;
}

/** The sidebar mark's glyph for a chat started from outside. */
export const BY_DOOR_GLYPH = "↗";

/** The mark's tooltip: who started it. */
export function byDoorTip(by: string): string {
  return `Started from outside Nightloom by ${by}`;
}

/** The nav row's word for the switch. */
export function doorWord(card: DoorCard | null): string {
  return card?.writes ? "start and message" : "read only";
}

/** A path as a shell takes it: quoted when it holds a space. */
export function shellWord(path: string): string {
  return /[^A-Za-z0-9_\-./]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path;
}

/** The command line he pastes for a first try, from the card's command. */
export function doorExample(card: DoorCard): string {
  const [exe, flag] = splitCommand(card.command);
  return `${shellWord(exe)} ${flag} list`;
}

/** The MCP server entry for another agent's config, from the card's command. */
export function doorMcpConfig(card: DoorCard, who: string): string {
  const [exe] = splitCommand(card.command);
  return JSON.stringify({ mcpServers: { nightloom: { command: exe, args: ["--mcp-serve", "--outside", "--as", who] } } }, null, 2);
}

function splitCommand(command: string): [string, string] {
  const at = command.lastIndexOf(" ");
  return at < 0 ? [command, "--chat"] : [command.slice(0, at), command.slice(at + 1)];
}
