export const WEB: string;
export const ROOT_INPUTS: string[];
export function webClosure(root: string): string[];
export function decide(args: {
  root: string;
  previousSha: string | undefined;
  git: (...args: string[]) => string;
  force?: boolean;
  branch?: string;
}): {
  build: boolean;
  reason: string;
};
