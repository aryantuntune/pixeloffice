// Orchestrates a greytHR sign-in: authenticate via the ESS client, map the
// department, upsert the user, and mint a PixelOffice JWT. Tracks the greytHR
// sessionId per user so logout can end the real session.

import { AVATAR_IDS, type AvatarId, type Department } from "@pixeloffice/shared";
import type { JwtService, Role } from "../jwt.service";
import type { StoredUser, UserRepository } from "../../repositories/user.repository";
import { roleForEmail } from "../rbac";
import { mapGreytHrDepartment } from "./department-map";
import {
  GreytHrEssError,
  type GreytHrAccount,
  type GreytHrEssClient,
  type GreytHrLoginInput,
} from "../../integrations/greythr/greythr-ess.client";

/** Identity + display fields returned to the client after a greytHR login. */
export interface GreytHrLoginProfile {
  /** Stable PixelOffice user id ("greythr:<employeeNo>"). */
  userId: string;
  name: string;
  /** Office department the avatar is routed to (mapped + fallback-resolved). */
  department: Department;
  email: string;
  employeeNo: string | null;
  designation: string | null;
  reportingManager: string | null;
  isManager: boolean;
  /** Default avatar derived from the stable id (the client may override it). */
  defaultAvatarId: AvatarId;
  /** Whether the greytHR department mapped cleanly (false = used the default). */
  departmentMapped: boolean;
}

export interface GreytHrLoginOutput {
  /** PixelOffice JWT — the client stores it and joins the room with it. */
  token: string;
  profile: GreytHrLoginProfile;
}

export interface GreytHrAuthServiceOptions {
  client: GreytHrEssClient;
  jwt: JwtService;
  users: UserRepository;
  /** Emails granted the `admin` role (RBAC). */
  adminEmails: Set<string>;
  /** Department used when the greytHR label does not map onto DEPARTMENTS. */
  defaultDepartment: Department;
  /** Lower-cased allowed email domains; empty = no restriction (parity with OAuth). */
  allowedEmailDomains?: Set<string>;
}

/** Login refused; carries an HTTP status for the route to return. */
export class GreytHrAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GreytHrAuthError";
  }
}

/** Deterministic avatar pick from a stable id (greytHR carries no avatar). */
function avatarForId(id: string): AvatarId {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_IDS[hash % AVATAR_IDS.length];
}

function emailDomainAllowed(email: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  return allowed.has(email.slice(at + 1).toLowerCase());
}

export class GreytHrAuthService {
  /** userId -> greytHR sessionId, captured at login so logout can end it. */
  private readonly sessions = new Map<string, string>();

  constructor(private readonly opts: GreytHrAuthServiceOptions) {}

  /** Sign in with greytHR credentials (employee no + password). */
  async loginWithCredentials(input: GreytHrLoginInput): Promise<GreytHrLoginOutput> {
    const { sessionId, account } = await this.guard(() => this.opts.client.login(input));
    return this.finalizeAndTrack(account, sessionId);
  }

  /** Sign in with an EXISTING greytHR sessionId (password-free hand-off). */
  async loginWithSession(sessionId: string): Promise<GreytHrLoginOutput> {
    const account = await this.guard(() => this.opts.client.getAccount(sessionId));
    return this.finalizeAndTrack(account, sessionId);
  }

  /** End this user's greytHR session and drop the mapping. Best-effort. */
  async logout(userId: string): Promise<void> {
    const sessionId = this.sessions.get(userId);
    this.sessions.delete(userId);
    if (!sessionId) return;
    try {
      await this.opts.client.logout(sessionId);
    } catch {
      /* best-effort: the greytHR session will expire on its own */
    }
  }

  /** Run a greytHR call and translate its typed errors into auth errors. */
  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof GreytHrEssError) {
        throw new GreytHrAuthError(this.publicMessage(err), this.statusFor(err));
      }
      throw new GreytHrAuthError("greytHR sign-in failed", 502);
    }
  }

  /** Map the account onto an identity + JWT, then remember the greytHR session. */
  private async finalizeAndTrack(
    account: GreytHrAccount,
    sessionId: string,
  ): Promise<GreytHrLoginOutput> {
    const out = await this.finalize(account);
    this.sessions.set(out.profile.userId, sessionId);
    return out;
  }

  /** Map a greytHR account onto a PixelOffice identity, persist it, mint a JWT. */
  private async finalize(account: GreytHrAccount): Promise<GreytHrLoginOutput> {
    const employeeNo = account.employeeNo ?? (account.loginId ?? null);
    if (!employeeNo) {
      throw new GreytHrAuthError("greytHR account is missing an employee id", 502);
    }
    const name = account.name?.trim() || employeeNo;
    const email = account.email ?? "";

    if (
      email &&
      this.opts.allowedEmailDomains &&
      !emailDomainAllowed(email, this.opts.allowedEmailDomains)
    ) {
      throw new GreytHrAuthError("This email domain is not allowed to sign in", 403);
    }

    const mapped = mapGreytHrDepartment(account.department);
    const department: Department = mapped ?? this.opts.defaultDepartment;

    const userId = `greythr:${employeeNo}`;
    const defaultAvatarId = avatarForId(userId);

    const user: StoredUser = {
      id: userId,
      name: name.slice(0, 24),
      department,
      avatarId: defaultAvatarId,
    };
    await this.opts.users.save(user);

    const role: Role = email ? roleForEmail(email, this.opts.adminEmails) : "member";

    // department is signed as the initial value; the client may override it.
    const token = this.opts.jwt.sign({
      sub: userId,
      email,
      name: user.name,
      role,
      department,
    });

    return {
      token,
      profile: {
        userId,
        name: user.name,
        department,
        email,
        employeeNo,
        designation: account.designation,
        reportingManager: account.reportingManager,
        isManager: account.isManager,
        defaultAvatarId,
        departmentMapped: mapped !== null,
      },
    };
  }

  private statusFor(err: GreytHrEssError): number {
    switch (err.kind) {
      case "credentials":
      case "unauthorized":
        return 401;
      case "bad_request":
        return 400;
      case "timeout":
      case "network":
        return 504;
      default:
        return 502;
    }
  }

  /** Keep upstream/internal detail out of the client-facing message. */
  private publicMessage(err: GreytHrEssError): string {
    switch (err.kind) {
      case "credentials":
        return "Invalid greytHR Employee No or password.";
      case "bad_request":
        return err.message;
      case "timeout":
      case "network":
        return "Could not reach greytHR. Please try again.";
      default:
        return "greytHR sign-in failed. Please try again.";
    }
  }
}
