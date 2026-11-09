/**
 * VS Code-backed storage for remote-server credentials: sessions in the OS
 * keychain via SecretStorage, and the "don't reuse the CLI session" list in
 * globalState (it holds only server URLs).
 */
import type * as vscode from "vscode";
import type { SessionCredential } from "./cliTokens";
import type { CliReuseGate, SessionVault } from "./credentials";

const SESSION_KEY_PREFIX = "omnigent.session:";
export const CLI_REUSE_BLOCKED_KEY = "omnigent.cliSessionReuseBlocked";

export class SecretSessionVault implements SessionVault {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(serverUrl: string): Promise<SessionCredential | undefined> {
    const raw = await this.secrets.get(SESSION_KEY_PREFIX + serverUrl);
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionCredential> | null;
      if (typeof parsed?.token !== "string" || parsed.token === "") {
        return undefined;
      }
      return {
        token: parsed.token,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
        userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      };
    } catch {
      return undefined;
    }
  }

  async save(serverUrl: string, session: SessionCredential): Promise<void> {
    await this.secrets.store(SESSION_KEY_PREFIX + serverUrl, JSON.stringify(session));
  }

  async delete(serverUrl: string): Promise<void> {
    await this.secrets.delete(SESSION_KEY_PREFIX + serverUrl);
  }
}

export class MementoCliReuseGate implements CliReuseGate {
  constructor(private readonly memento: vscode.Memento) {}

  isBlocked(serverUrl: string): boolean {
    return this.blocked().includes(serverUrl);
  }

  async setBlocked(serverUrl: string, blocked: boolean): Promise<void> {
    const others = this.blocked().filter((url) => url !== serverUrl);
    if (blocked === this.isBlocked(serverUrl)) {
      return;
    }
    await this.memento.update(CLI_REUSE_BLOCKED_KEY, blocked ? [...others, serverUrl] : others);
  }

  private blocked(): string[] {
    const raw = this.memento.get<unknown>(CLI_REUSE_BLOCKED_KEY);
    return Array.isArray(raw) ? raw.filter((url): url is string => typeof url === "string") : [];
  }
}
