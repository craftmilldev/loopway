import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/", ".claude/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "packages/web/vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // An async function with no await is how we satisfy interfaces that return promises.
    rules: { "@typescript-eslint/require-await": "off" },
  },
  // Plain .mjs so Vercel can run it before `npm install`; it has no tsconfig, so no type-aware rules.
  { files: ["packages/web/scripts/should-build.mjs"], extends: [tseslint.configs.disableTypeChecked] },
  // Tests read JSON as `any`; checking those types would mean a cast per assertion.
  {
    files: ["packages/*/test/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
  // Last, so it turns off any rule that would fight Prettier's formatting.
  prettier,
);
