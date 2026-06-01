import type { Decision } from '../types.js';

/**
 * Codex app-server v2 protocol review decision values.
 * Confirmed via PoC with codex 0.135.0-alpha.1.
 */
export type CodexReviewDecision =
  | 'accept'
  | 'decline'
  | 'cancel';

/**
 * ServerRequest method — determines which type of approval is being requested.
 */
export type CodexServerRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput';

/**
 * Categorized kind for each ServerRequest method.
 * Used by CodexAppServerClient to route response formatting.
 */
export type ServerRequestKind =
  | 'approval'      // respond with { decision: 'accept'|'decline'|'cancel' }
  | 'permissions'   // respond with { permissions: {...}, scope: 'turn' } — MVP unsupported
  | 'input';        // respond with { answers: { [qId]: { answers: string[] } } }

/**
 * Map CodeKey wire decision (unchanged from phone) to Codex app-server v2 decision.
 *
 * Design rule:
 * - Wire protocol stays `'approve'|'deny'|'reply'|'pause'` (types.ts Decision).
 * - Mapping happens in this function, bridge-side only.
 * - Claude Code path (handler.ts:158 boolean resolve) is untouched.
 *
 * @param ckd CodeKey phone decision
 * @returns Codex app-server v2 decision value
 */
export function toCodexDecision(ckd: Decision): CodexReviewDecision {
  switch (ckd) {
    case 'approve':
      return 'accept';
    case 'deny':
      return 'decline';
    case 'pause':
      return 'cancel';
    case 'reply':
      // 'reply' does not map to a command/file/permission approval response.
      // It should be handled via a separate `item/tool/requestUserInput` path.
      // If it reaches here it's a programming error.
      throw new Error('reply decision cannot map to a Codex ReviewDecision; use requestUserInput path instead');
  }
}

/**
 * Categorize a ServerRequest method into its kind for response routing.
 * - 'approval': responds with { decision: 'accept'|'decline'|'cancel' }
 * - 'permissions': responds with { permissions: {...}, scope: 'turn' } — MVP unsupported, warn on receipt
 * - 'input': responds with { answers: { [qId]: { answers: string[] } } }
 * - null: unknown method, caller should warn and skip
 */
export function classifyServerRequest(method: string): ServerRequestKind | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return 'approval';
    case 'item/permissions/requestApproval':
      return 'permissions';
    case 'item/tool/requestUserInput':
      return 'input';
    default:
      return null;
  }
}

export function isApprovalMethod(method: string): boolean {
  return classifyServerRequest(method) === 'approval';
}

export function isInputMethod(method: string): boolean {
  return classifyServerRequest(method) === 'input';
}

export function isPermissionsMethod(method: string): boolean {
  return classifyServerRequest(method) === 'permissions';
}
