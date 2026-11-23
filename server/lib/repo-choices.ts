/** Repos a project's items already name: each in its most used spelling, the one each app's items use most, and the
 * project's most used. */
export interface RepoChoices { repos: string[]; byApp: Record<string, string>; usual: string | null }

/** The repo a new item in `app` most likely belongs to. */
export function usualRepo(choices: RepoChoices, app: string | null | undefined): string {
  return choices.byApp[(app ?? "").trim()] ?? choices.usual ?? "";
}
