import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "out/**", ".wrangler/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        Blob: "readonly",
        File: "readonly",
        FormData: "readonly",
        MediaRecorder: "readonly",
        AudioContext: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        performance: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
];
