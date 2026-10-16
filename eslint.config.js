import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/", ".claude/", ".data/", "packages/web/public/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "packages/web/vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // An async function with no await is how we satisfy interfaces that return promises.
    rules: { "@typescript-eslint/require-await": "off" },
  },
  // The classic hook rules only; the rest of the plugin's recommended set is for the React Compiler, which we don't use.
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  // Commander types action arguments as `any`; the command functions declare the option shapes.
  { files: ["packages/cli/src/program.ts"], rules: { "@typescript-eslint/no-unsafe-argument": "off" } },
  // Tests read JSON responses as `any` all over; checking those types would mean a cast per assertion.
  {
    files: ["packages/*/test/**", "packages/*/ee/test/**"],
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
