import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./", import.meta.url)),
  // Outside Next's own webpack build there is no bundler-level
  // "react-server" condition to resolve the `server-only` package to
  // its no-op `empty.js`, so its default entry point unconditionally
  // throws. Point straight at that same empty.js so modules marked
  // server-only can still be imported (and mocked) under Vitest.
  "server-only": fileURLToPath(
    new URL("./node_modules/server-only/empty.js", import.meta.url),
  ),
};

/* TWO PROJECTS, because two different questions need two environments.
 *
 * "node" is every test this repo already had, unmoved: pure logic, and
 * server components put through renderToStaticMarkup, which needs no DOM
 * and is the right tool for "what does a reader read".
 *
 * "jsdom" exists for exactly what the other one cannot ask. A guard made
 * of an event listener -- useLeaveGuard in components/admin/EditTabs.tsx
 * -- has no markup to assert on and no return value: it is a capture
 * listener on `document` that either intercepts a click or does not.
 * With no DOM, no effect runs and no click can be dispatched, so the
 * only available assertions were regexes over the component's own source
 * text. Those prove the file CONTAINS a string. A typo'd selector, an
 * effect that never registers, or a listener attached in bubble phase
 * would have left every one of them green, along with tsc, lint and the
 * build. The whole of the defect a product owner actually reported would
 * have shipped unproven.
 *
 * The split is by extension as well as directory so the two never
 * overlap: node takes lib/**\/*.test.ts, jsdom takes
 * components/**\/*.test.tsx.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          include: ["lib/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["components/**/*.test.tsx"],
        },
      },
    ],
  },
});
