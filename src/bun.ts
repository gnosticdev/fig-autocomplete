import {
    filepaths,
    keyValueList,
    valueList,
} from "@fig/autocomplete-generators";
import { npmScriptsGenerator } from "./npm";
import { npxSuggestions } from "./npx";
import { createCLIsGenerator } from "./yarn";

type SearchTermMatcher = RegExpExecArray & {
  groups?: {
    scope: string | undefined;
    searchTerm: string;
    version: string | undefined;
  };
};

// types keys only for the fields we need, not the entire npms suggestion
type NpmsSuggestion = {
  package: {
    name: string;
    version: string;
    description: string;
  };
  [key: string]: unknown;
};
type NpmsSearchResult = {
  total: number;
  results: NpmsSuggestion[];
};
type NpmPackageMeta = {
  "dist-tags": {
    latest: string;
    [key: string]: string;
  };
  name: string;
  versions: {
    [version: string]: Record<string, unknown>;
  };
};
type GetPackagesParams = {
  /** regex exec match array - separates input into npm package parts */
  searchMatchArray: SearchTermMatcher | null;
  /** keywords passed from outside context */
  keywords?: string[] | undefined;
};

/** custom generator searches npm registry or npms.io api for packages or pkg versions */
const npmSearchHandler: (keywords?: string[]) => Fig.Generator["custom"] =
  (keywords) =>
  async (
    _tokens,
    executeShellCommand,
    generatorContext
  ): Promise<Fig.Suggestion[]> => {
    const { searchTerm: ctxSearchTerm } = generatorContext;

    if (!ctxSearchTerm) {
      return [];
    }

    const getPackageMeta = async (searchTerm: string) => {
      // Remove the last character from the search term, which is the version
      searchTerm = searchTerm.slice(0, -1);

      const { stdout } = await executeShellCommand({
        command: "curl",
        args: [
          "-s",
          "-H",
          "Accept: application/vnd.npm.install-v1+json",
          `https://registry.npmjs.org/${searchTerm}`,
        ],
      });

      return JSON.parse(stdout) as NpmPackageMeta;
    };

    const getPackages = async ({
      searchMatchArray,
      keywords,
    }: GetPackagesParams): Promise<NpmsSuggestion[]> => {
      const matchedTerm = searchMatchArray?.[0];
      if (!matchedTerm) {
        return [];
      }

      const searchParams = {
        q: matchedTerm,
        size: 20,
      };

      //scope & keywords modifiers can only be used on the /search endpoint
      const scope = searchMatchArray?.groups?.scope;
      if (scope || keywords?.length > 0) {
        const scopeParam = scope ? `+scope:${scope}` : "";
        /** keywords and scope can only be used on the /search endpoint */
        const keywordsParam =
          keywords?.length > 0 ? `+keywords:${keywords.join(",")}` : "";
        searchParams.q = `${matchedTerm}${scopeParam}${keywordsParam}`;

        const searchUrl =
          "https://api.npms.io/v2/search" +
          "?" +
          `${Object.keys(searchParams)
            .map((key) => `${key}=${searchParams[key]}`)
            .join("&")}`;

        const { stdout } = await executeShellCommand({
          command: "curl",
          args: ["-s", "-H", "Accept: application/json", searchUrl],
        });

        return (JSON.parse(stdout) as NpmsSearchResult).results;
      }

      // ignores qualifiers like :scope, :keywords
      const suggestionUrl =
        "https://api.npms.io/v2/search/suggestions" +
        "?" +
        `${Object.keys(searchParams)
          .map((key) => `${key}=${searchParams[key]}`)
          .join("&")}`;

      const { stdout } = await executeShellCommand({
        command: "curl",
        args: ["-s", "-H", '"Accept: application/json"', suggestionUrl],
      });

      return JSON.parse(stdout) as NpmsSuggestion[];
    };

    /**
     * Regex to match npm package names with optional scope and version
     * @example
     * `@types/pkg@1.0.0` -> {scope: types,  scopeTerm: pkg, version @1.0.0}
     * @see https://regex101.com/r/aaF8RF/1
     */
    const regex =
      /^(?:@(?<scope>[\w-]+)\/)?(?<searchTerm>@?[\w\-/]+)?(?<version>@.*)?$/;

    const searchMatchArray = regex.exec(ctxSearchTerm) as SearchTermMatcher;

    if (!searchMatchArray) {
      return [];
    }

    try {
      // version is matched from '@' to end of string, e.g. @latest
      if (searchMatchArray?.groups?.version) {
        const pkgMeta = await getPackageMeta(searchMatchArray[0]);

        if (!("dist-tags" in pkgMeta)) {
          return [];
        }

        // create dist tags suggestions at top
        const versions = Object.entries(pkgMeta["dist-tags"]).map(
          ([key, value]) => ({
            name: key,
            description: value,
          })
        ) as Fig.Suggestion[];
        // version suggestions underneath -> reverse bc latest is last
        versions.push(
          ...Object.keys(pkgMeta.versions)
            .map((version) => ({ name: version }) as Fig.Suggestion)
            .reverse()
        );

        return versions;
      }

      const suggestions = await getPackages({
        searchMatchArray,
        keywords,
      });

      return suggestions.map(
        (item) =>
          ({
            name: item.package.name,
            description: item.package.description,
          }) as Fig.Suggestion
      );
    } catch (error) {
      console.error(error);
      return [];
    }
  };

// GENERATORS
export const searchNpmGenerator: Fig.Generator = {
  trigger: (newToken, oldToken) => {
    if (newToken === oldToken || newToken === "@") {
      return false;
    }
    return true;
  },
  // only change the query term for version suggestions
  getQueryTerm: (token) => {
    if (token.lastIndexOf("@") > 0) {
      return token.split("@").at(-1);
    }
    return token;
  },
  cache: {
    ttl: 1000 * 60 * 60 * 24 * 2, // 2 days
  },
  custom: npmSearchHandler(),
};

/**
 * Similar to the npm dependency generator, but points to different global directory
 */
const bunDependencyGenerator: Fig.Generator = {
  trigger: (newToken) => newToken === "-g" || newToken === "--global",
  custom: async function (tokens, executeShellCommand, ctx) {
    console.log(ctx);
    // check if global flag is present
    const packageParser = (
      packageContent: Record<string, Record<string, string>>
    ) => {
      const dependencies = packageContent["dependencies"] ?? {};
      const devDependencies = packageContent["devDependencies"] ?? {};
      const optionalDependencies = packageContent["optionalDependencies"] ?? {};
      const packages = {
        ...dependencies,
        ...devDependencies,
        ...optionalDependencies,
      };
      return Object.keys(packages)
        .filter((pkgName) => {
          return !tokens.some((current) => current === pkgName);
        })
        .map((pkgName) => ({
          name: pkgName,
          icon: "📦",
          priority: 100,
          description: dependencies[pkgName]
            ? "dependency"
            : optionalDependencies[pkgName]
            ? "optionalDependency"
            : "devDependency",
        })) as Fig.Suggestion[];
    };
    if (tokens.some((t) => t === "-g" || t === "--global")) {
      const { stdout: globalPkgs } = await executeShellCommand({
        command: "cat",
        // eslint-disable-next-line @withfig/fig-linter/no-useless-arrays
        args: [
          `${ctx.environmentVariables["BUN_INSTALL"]}/install/global/package.json`,
        ],
      });

      console.log("isGlobal: ", globalPkgs);

      const packageContent = JSON.parse(globalPkgs);
      return packageParser(packageContent).map((pkg) => ({
        ...pkg,
        description: pkg.description + " (global)",
      })) as Fig.Suggestion[];
    }

    const { stdout: projectRoot } = await executeShellCommand({
      command: "npm",
      // eslint-disable-next-line @withfig/fig-linter/no-useless-arrays
      args: ["prefix"],
    });

    const { stdout } = await executeShellCommand({
      command: "cat",
      // eslint-disable-next-line @withfig/fig-linter/no-useless-arrays
      args: ["package.json"],
      cwd: projectRoot,
    });

    const packageContent = JSON.parse(stdout);
    return packageParser(packageContent);
  },
};

const icon =
  "data:image/svg+xml;base64,PHN2ZyBpZD0iQnVuIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4MCA3MCI+PHRpdGxlPkJ1biBMb2dvPC90aXRsZT48cGF0aCBpZD0iU2hhZG93IiBkPSJNNzEuMDksMjAuNzRjLS4xNi0uMTctLjMzLS4zNC0uNS0uNXMtLjMzLS4zNC0uNS0uNS0uMzMtLjM0LS41LS41LS4zMy0uMzQtLjUtLjUtLjMzLS4zNC0uNS0uNS0uMzMtLjM0LS41LS41LS4zMy0uMzQtLjUtLjVBMjYuNDYsMjYuNDYsMCwwLDEsNzUuNSwzNS43YzAsMTYuNTctMTYuODIsMzAuMDUtMzcuNSwzMC4wNS0xMS41OCwwLTIxLjk0LTQuMjMtMjguODMtMTAuODZsLjUuNS41LjUuNS41LjUuNS41LjUuNS41LjUuNUMxOS41NSw2NS4zLDMwLjE0LDY5Ljc1LDQyLDY5Ljc1YzIwLjY4LDAsMzcuNS0xMy40OCwzNy41LTMwQzc5LjUsMzIuNjksNzYuNDYsMjYsNzEuMDksMjAuNzRaIi8+PGcgaWQ9IkJvZHkiPjxwYXRoIGlkPSJCYWNrZ3JvdW5kIiBkPSJNNzMsMzUuN2MwLDE1LjIxLTE1LjY3LDI3LjU0LTM1LDI3LjU0UzMsNTAuOTEsMywzNS43QzMsMjYuMjcsOSwxNy45NCwxOC4yMiwxM1MzMy4xOCwzLDM4LDNzOC45NCw0LjEzLDE5Ljc4LDEwQzY3LDE3Ljk0LDczLDI2LjI3LDczLDM1LjdaIiBzdHlsZT0iZmlsbDojZmJmMGRmIi8+PHBhdGggaWQ9IkJvdHRvbV9TaGFkb3ciIGRhdGEtbmFtZT0iQm90dG9tIFNoYWRvdyIgZD0iTTczLDM1LjdhMjEuNjcsMjEuNjcsMCwwLDAtLjgtNS43OGMtMi43MywzMy4zLTQzLjM1LDM0LjktNTkuMzIsMjQuOTRBNDAsNDAsMCwwLDAsMzgsNjMuMjRDNTcuMyw2My4yNCw3Myw1MC44OSw3MywzNS43WiIgc3R5bGU9ImZpbGw6I2Y2ZGVjZSIvPjxwYXRoIGlkPSJMaWdodF9TaGluZSIgZGF0YS1uYW1lPSJMaWdodCBTaGluZSIgZD0iTTI0LjUzLDExLjE3QzI5LDguNDksMzQuOTQsMy40Niw0MC43OCwzLjQ1QTkuMjksOS4yOSwwLDAsMCwzOCwzYy0yLjQyLDAtNSwxLjI1LTguMjUsMy4xMy0xLjEzLjY2LTIuMywxLjM5LTMuNTQsMi4xNS0yLjMzLDEuNDQtNSwzLjA3LTgsNC43QzguNjksMTguMTMsMywyNi42MiwzLDM1LjdjMCwuNCwwLC44LDAsMS4xOUM5LjA2LDE1LjQ4LDIwLjA3LDEzLjg1LDI0LjUzLDExLjE3WiIgc3R5bGU9ImZpbGw6I2ZmZmVmYyIvPjxwYXRoIGlkPSJUb3AiIGQ9Ik0zNS4xMiw1LjUzQTE2LjQxLDE2LjQxLDAsMCwxLDI5LjQ5LDE4Yy0uMjguMjUtLjA2LjczLjMuNTksMy4zNy0xLjMxLDcuOTItNS4yMyw2LTEzLjE0QzM1LjcxLDUsMzUuMTIsNS4xMiwzNS4xMiw1LjUzWm0yLjI3LDBBMTYuMjQsMTYuMjQsMCwwLDEsMzksMTljLS4xMi4zNS4zMS42NS41NS4zNkM0MS43NCwxNi41Niw0My42NSwxMSwzNy45Myw1LDM3LjY0LDQuNzQsMzcuMTksNS4xNCwzNy4zOSw1LjQ5Wm0yLjc2LS4xN0ExNi40MiwxNi40MiwwLDAsMSw0NywxNy4xMmEuMzMuMzMsMCwwLDAsLjY1LjExYy45Mi0zLjQ5LjQtOS40NC03LjE3LTEyLjUzQzQwLjA4LDQuNTQsMzkuODIsNS4wOCw0MC4xNSw1LjMyWk0yMS42OSwxNS43NmExNi45NCwxNi45NCwwLDAsMCwxMC40Ny05Yy4xOC0uMzYuNzUtLjIyLjY2LjE4LTEuNzMsOC03LjUyLDkuNjctMTEuMTIsOS40NUMyMS4zMiwxNi40LDIxLjMzLDE1Ljg3LDIxLjY5LDE1Ljc2WiIgc3R5bGU9ImZpbGw6I2NjYmVhNztmaWxsLXJ1bGU6ZXZlbm9kZCIvPjxwYXRoIGlkPSJPdXRsaW5lIiBkPSJNMzgsNjUuNzVDMTcuMzIsNjUuNzUuNSw1Mi4yNy41LDM1LjdjMC0xMCw2LjE4LTE5LjMzLDE2LjUzLTI0LjkyLDMtMS42LDUuNTctMy4yMSw3Ljg2LTQuNjIsMS4yNi0uNzgsMi40NS0xLjUxLDMuNi0yLjE5QzMyLDEuODksMzUsLjUsMzgsLjVzNS42MiwxLjIsOC45LDMuMTRjMSwuNTcsMiwxLjE5LDMuMDcsMS44NywyLjQ5LDEuNTQsNS4zLDMuMjgsOSw1LjI3QzY5LjMyLDE2LjM3LDc1LjUsMjUuNjksNzUuNSwzNS43LDc1LjUsNTIuMjcsNTguNjgsNjUuNzUsMzgsNjUuNzVaTTM4LDNjLTIuNDIsMC01LDEuMjUtOC4yNSwzLjEzLTEuMTMuNjYtMi4zLDEuMzktMy41NCwyLjE1LTIuMzMsMS40NC01LDMuMDctOCw0LjdDOC42OSwxOC4xMywzLDI2LjYyLDMsMzUuNywzLDUwLjg5LDE4LjcsNjMuMjUsMzgsNjMuMjVTNzMsNTAuODksNzMsMzUuN0M3MywyNi42Miw2Ny4zMSwxOC4xMyw1Ny43OCwxMyw1NCwxMSw1MS4wNSw5LjEyLDQ4LjY2LDcuNjRjLTEuMDktLjY3LTIuMDktMS4yOS0zLTEuODRDNDIuNjMsNCw0MC40MiwzLDM4LDNaIi8+PC9nPjxnIGlkPSJNb3V0aCI+PGcgaWQ9IkJhY2tncm91bmQtMiIgZGF0YS1uYW1lPSJCYWNrZ3JvdW5kIj48cGF0aCBkPSJNNDUuMDUsNDNhOC45Myw4LjkzLDAsMCwxLTIuOTIsNC43MSw2LjgxLDYuODEsMCwwLDEtNCwxLjg4QTYuODQsNi44NCwwLDAsMSwzNCw0Ny43MSw4LjkzLDguOTMsMCwwLDEsMzEuMTIsNDNhLjcyLjcyLDAsMCwxLC44LS44MUg0NC4yNkEuNzIuNzIsMCwwLDEsNDUuMDUsNDNaIiBzdHlsZT0iZmlsbDojYjcxNDIyIi8+PC9nPjxnIGlkPSJUb25ndWUiPjxwYXRoIGlkPSJCYWNrZ3JvdW5kLTMiIGRhdGEtbmFtZT0iQmFja2dyb3VuZCIgZD0iTTM0LDQ3Ljc5YTYuOTEsNi45MSwwLDAsMCw0LjEyLDEuOSw2LjkxLDYuOTEsMCwwLDAsNC4xMS0xLjksMTAuNjMsMTAuNjMsMCwwLDAsMS0xLjA3LDYuODMsNi44MywwLDAsMC00LjktMi4zMSw2LjE1LDYuMTUsMCwwLDAtNSwyLjc4QzMzLjU2LDQ3LjQsMzMuNzYsNDcuNiwzNCw0Ny43OVoiIHN0eWxlPSJmaWxsOiNmZjYxNjQiLz48cGF0aCBpZD0iT3V0bGluZS0yIiBkYXRhLW5hbWU9Ik91dGxpbmUiIGQ9Ik0zNC4xNiw0N2E1LjM2LDUuMzYsMCwwLDEsNC4xOS0yLjA4LDYsNiwwLDAsMSw0LDEuNjljLjIzLS4yNS40NS0uNTEuNjYtLjc3YTcsNywwLDAsMC00LjcxLTEuOTMsNi4zNiw2LjM2LDAsMCwwLTQuODksMi4zNkE5LjUzLDkuNTMsMCwwLDAsMzQuMTYsNDdaIi8+PC9nPjxwYXRoIGlkPSJPdXRsaW5lLTMiIGRhdGEtbmFtZT0iT3V0bGluZSIgZD0iTTM4LjA5LDUwLjE5YTcuNDIsNy40MiwwLDAsMS00LjQ1LTIsOS41Miw5LjUyLDAsMCwxLTMuMTEtNS4wNSwxLjIsMS4yLDAsMCwxLC4yNi0xLDEuNDEsMS40MSwwLDAsMSwxLjEzLS41MUg0NC4yNmExLjQ0LDEuNDQsMCwwLDEsMS4xMy41MSwxLjE5LDEuMTksMCwwLDEsLjI1LDFoMGE5LjUyLDkuNTIsMCwwLDEtMy4xMSw1LjA1QTcuNDIsNy40MiwwLDAsMSwzOC4wOSw1MC4xOVptLTYuMTctNy40Yy0uMTYsMC0uMi4wNy0uMjEuMDlhOC4yOSw4LjI5LDAsMCwwLDIuNzMsNC4zN0E2LjIzLDYuMjMsMCwwLDAsMzguMDksNDlhNi4yOCw2LjI4LDAsMCwwLDMuNjUtMS43Myw4LjMsOC4zLDAsMCwwLDIuNzItNC4zNy4yMS4yMSwwLDAsMC0uMi0uMDlaIi8+PC9nPjxnIGlkPSJGYWNlIj48ZWxsaXBzZSBpZD0iUmlnaHRfQmx1c2giIGRhdGEtbmFtZT0iUmlnaHQgQmx1c2giIGN4PSI1My4yMiIgY3k9IjQwLjE4IiByeD0iNS44NSIgcnk9IjMuNDQiIHN0eWxlPSJmaWxsOiNmZWJiZDAiLz48ZWxsaXBzZSBpZD0iTGVmdF9CbHVjaCIgZGF0YS1uYW1lPSJMZWZ0IEJsdWNoIiBjeD0iMjIuOTUiIGN5PSI0MC4xOCIgcng9IjUuODUiIHJ5PSIzLjQ0IiBzdHlsZT0iZmlsbDojZmViYmQwIi8+PHBhdGggaWQ9IkV5ZXMiIGQ9Ik0yNS43LDM4LjhhNS41MSw1LjUxLDAsMSwwLTUuNS01LjUxQTUuNTEsNS41MSwwLDAsMCwyNS43LDM4LjhabTI0Ljc3LDBBNS41MSw1LjUxLDAsMSwwLDQ1LDMzLjI5LDUuNSw1LjUsMCwwLDAsNTAuNDcsMzguOFoiIHN0eWxlPSJmaWxsLXJ1bGU6ZXZlbm9kZCIvPjxwYXRoIGlkPSJJcmlzIiBkPSJNMjQsMzMuNjRhMi4wNywyLjA3LDAsMSwwLTIuMDYtMi4wN0EyLjA3LDIuMDcsMCwwLDAsMjQsMzMuNjRabTI0Ljc3LDBhMi4wNywyLjA3LDAsMSwwLTIuMDYtMi4wN0EyLjA3LDIuMDcsMCwwLDAsNDguNzUsMzMuNjRaIiBzdHlsZT0iZmlsbDojZmZmO2ZpbGwtcnVsZTpldmVub2RkIi8+PC9nPjwvc3ZnPg==";

/** Suggest common ports for the various --inspect options */
const inspectArgs: Fig.SingleOrArray<Fig.Arg> = {
  name: "[host:]port",
  isOptional: true,
  suggestions: [
    {
      name: "3000",
      icon: "fig://icon?type=box",
      description: "Serve on port 3000",
    },
    {
      name: "8080",
      icon: "fig://icon?type=box",
      description: "Serve on port 8080",
    },
  ],
  description: "Activate inspector on particular port and/or hostname",
};

const loaders = [
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "toml",
  "text",
  "file",
  "wasm",
  "napi",
];
/** Format from https://github.com/oven-sh/bun/blob/dcbcf9803a19be989c0f48d22a50a43731fcfacd/src/cli.zig */
const sharedPublicParams: Fig.Option[] = [
  {
    name: ["-h", "--help"],
    description: "Display this help and exit",
  },
  {
    name: ["-b", "--bun"],
    description:
      "Force a script or package to use Bun's runtime instead of Node.js (via symlinking node)",
  },
  {
    name: "--cwd",
    args: {
      name: "path",
      description:
        "Absolute path to resolve files & entry points from. This just changes the process' cwd",
    },
  },
  {
    name: ["-c", "--config"],
    args: {
      name: "path",
      template: "filepaths",
      description: "Config file to load Bun from (e.g. -c bunfig.toml)",
      isOptional: true,
    },
    description: "Load config (bunfig.toml)",
  },
  {
    name: "--extension-order",
    args: {
      name: "order",
      isVariadic: true,
      description: "Defaults to: .tsx,.ts,.jsx,.js,.json",
    },
  },
  {
    name: "--jsx-factory",
    args: {
      name: "name",
      suggestions: ["React.createElement", "h", "preact.h"],
    },
    description: `Changes the function called when compiling JSX elements using the classic JSX runtime`,
  },
  {
    name: "--jsx-fragment",
    priority: 49,
    args: { name: "string", isOptional: true },
    insertValue: "--jsx-fragment='{cursor}'",
    description: "Changes the function called when compiling JSX fragments",
  },
  {
    name: "--jsx-import-source",
    args: { name: "module", suggestions: ["react"] },
    description: `Declares the module specifier to be used for importing the jsx and jsxs factory functions. Default: "react"`,
  },
  {
    name: "--jsx-runtime",
    args: { name: "name", suggestions: ["automatic", "classic"] },
    description: `"automatic" (default) or "classic"`,
  },
  {
    name: ["-r", "--preload"],
    args: {
      name: "args",
      isVariadic: true,
      description: "Import a module before other modules are loaded",
    },
  },
  {
    name: "--main-fields",
    args: {
      name: "args",
      isVariadic: true,
      description:
        "Main fields to lookup in package.json. Defaults to --target dependent",
    },
  },
  {
    name: "--no-summary",
    description: "Don't print a summary (when generating .bun)",
  },
  {
    name: ["-v", "--version"],
    description: "Print version and exit",
  },
  {
    name: "--revision",
    description: "Print version with revision and exit",
  },
  {
    name: "--tsconfig-override",
    args: {
      name: "overrides",
      description: "Load tsconfig from path instead of cwd/tsconfig.json",
    },
  },
  {
    name: ["-d", "--define"],
    args: {
      name: "k=v",
      isVariadic: true,
      description:
        "Substitute key=value while parsing, e.g. --define process.env.NODE_ENV=development",
    },
  },
  {
    name: ["-e", "--external"],
    args: {
      name: "args",
      isVariadic: true,
      description:
        "Exclude module from transpilation (can use * wildcards). ex: -e react",
    },
  },
  {
    name: ["-l", "--loader"],
    args: {
      name: "args",
      isVariadic: true,
      description:
        "Parse files with .ext:loader, e.g. --loader .js:jsx. Valid loaders: js, jsx, ts, tsx, json, toml, text, file, wasm, napi",
      generators: keyValueList({
        keys: loaders.map((loader) => "." + loader),
        values: loaders,
      }),
    },
  },
  {
    name: ["-u", "--origin"],
    args: {
      name: "args",
      description: 'Rewrite import URLs to start with --origin. Default: ""',
    },
  },
  {
    name: ["-p", "--port"],
    args: {
      name: "args",
      description: 'Port to serve Bun\'s dev server on. Default: "3000"',
    },
  },
  {
    name: "--smol",
    description: "Use less memory, but run garbage collection more often",
  },
  {
    name: "--minify",
    description: "Minify (experimental)",
    priority: 50,
  },
  {
    name: "--minify-syntax",
    description: "Minify syntax and inline data (experimental)",
  },
  {
    name: "--minify-whitespace",
    description: "Minify whitespace (experimental)",
  },
  {
    name: "--minify-identifiers",
    description: "Minify identifiers",
  },
  {
    name: "--no-macros",
    description:
      "Disable macros from being executed in the bundler, transpiler and runtime",
  },
  {
    name: "--target",
    description: "Target environment",
    priority: 50,
    args: {
      generators: valueList({
        values: ["node", "browser", "bun"],
      }),
    },
  },
  {
    name: "--inspect",
    description: "Activate Bun's debugger for a file",
    requiresSeparator: true,
    args: inspectArgs,
  },
  {
    name: "--inspect-wait",
    description:
      "Activate Bun's Debugger, wait for a connection before executing",
    requiresSeparator: true,
    args: inspectArgs,
  },
  {
    name: "--inspect-brk",
    description:
      "Activate Bun's Debugger, set breakpoint on first line of code and wait",
    requiresSeparator: true,
    args: inspectArgs,
  },
  {
    name: "--if-present",
    description: "Exit if the entrypoint does not exist",
  },
];

// note: we are keeping --port and --origin as it can be reused for bun build and elsewhere
const notBunDevFlags: Fig.Option[] = [
  {
    name: "--hot",
    description:
      "Enable auto reload in the Bun runtime, test runner, or bundler",
    priority: 50,
  },
  {
    name: "--watch",
    description: "Automatically restart the process on file change",
    priority: 50,
  },
  {
    name: "--no-install",
    description: "Disable auto install in the Bun runtime",
  },
  {
    name: "-i",
    description:
      "Automatically install dependencies and use global cache in Bun's runtime, equivalent to --install=fallback",
  },
  {
    name: "--install",
    args: {
      name: "arg",
      description: `Install dependencies automatically when no node_modules are present, default: "auto". "force" to ignore node_modules, fallback to install any missing`,
      suggestions: ["auto", "force", "fallback", "disable"],
    },
  },
  {
    name: "--prefer-offline",
    description:
      "Skip staleness checks for packages in the Bun runtime and resolve from disk",
  },
  {
    name: "--prefer-latest",
    description:
      "Use the latest matching versions of packages in the Bun runtime, always checking npm",
  },
  {
    name: "--silent",
    description: "Don't repeat the command for bun run",
  },
];

const buildOnlyParams: Fig.Option[] = [
  {
    name: "compile",
    description:
      "Generate a standalone Bun executable containing your bundled code",
    priority: 50,
  },
  {
    name: "--format",
    description:
      "Specifies the module format to build to. Only esm is supported currently",
    args: {
      name: "args",
      suggestions: ["esm"],
    },
  },
  {
    name: "--outdir",
    description: 'Default to "dist" if multiple files',
    priority: 50,
    args: {
      name: "path",
    },
  },
  {
    name: "--outfile",
    description: "Write to a file",
    priority: 50,
    args: {
      name: "path",
    },
  },
  {
    name: "--root",
    description: "Root directory used for multiple entry points",
    args: {
      name: "path",
    },
  },
  {
    name: "--splitting",
    description: "Enable code splitting",
    priority: 50,
  },
  {
    name: "--public-path",
    description: "A prefix to be appended to any import paths in bundled code",
    args: {
      name: "args",
    },
  },
  {
    name: "--sourcemap",
    description: "Build with sourcemaps - 'inline', 'external', or 'none'",
    requiresSeparator: "-",
    priority: 50,
    args: {
      name: "args",
      isOptional: true,
      suggestions: ["inline", "external", "none"],
    },
  },
  {
    name: "--entry-naming",
    description:
      'Customize entry point filenames. Defaults to "[dir]/[name].[ext]"',
    args: {
      name: "args",
    },
  },
  {
    name: "--chunk-naming",
    description: 'Customize chunk filenames. Defaults to "[name]-[hash].[ext]"',
    args: {
      name: "args",
    },
  },
  {
    name: "--asset-naming",
    description: 'Customize asset filenames. Defaults to "[name]-[hash].[ext]"',
    args: {
      name: "args",
    },
  },
  {
    name: "--server-components",
    description: "Enable React Server Components (experimental)",
  },
  {
    name: "--no-bundle",
    description: "Transpile file only, do not bundle",
  },
];

const testOnlyParams: Fig.Option[] = [
  {
    name: "--timeout",
    description: "Set the per-test timeout in milliseconds, default is 5000",
    args: {
      name: "number",
    },
  },
  {
    name: "--update-snapshots",
    description: "Update snapshot files",
  },
  {
    name: "--rerun-each",
    description:
      "Re-run each test file <NUMBER> times, helps catch certain bugs",
    args: {
      name: "number",
    },
  },
  {
    name: "--only",
    description: 'Only run tests that are marked with "test.only()"',
  },
  {
    name: "--todo",
    description: 'Include tests that are marked with "test.todo()"',
  },
  {
    name: "--coverage",
    description: "Generate a coverage profile",
  },
  {
    name: "--bail",
    description:
      "Exit the test suite after <NUMBER> failures. If you do not specify a number, it defaults to 1",
    args: {
      name: "number",
      isOptional: true,
    },
  },
  {
    name: ["-t", "--test-name-pattern"],
    description: "Run only tests with a name that matches the given regex",
    args: {
      name: "pattern",
    },
  },
];

const debugParams: Fig.Option[] = [
  {
    name: "--dump-environment-variables",
    description:
      "Dump environment variables from .env and process as JSON and quit. Useful for debugging",
    priority: 49,
  },
  {
    name: "--dump-limits",
    description: "Dump system limits. Useful for debugging",
    priority: 49,
  },
];

const publicParams = [...sharedPublicParams, ...notBunDevFlags];
const buildParams = [...publicParams, ...buildOnlyParams, ...debugParams];
const testParams = [...publicParams, ...testOnlyParams, ...debugParams];

const dependencyOptions: Fig.Option[] = [
  {
    name: ["-c", "--config"],
    args: {
      name: "path",
      template: "filepaths",
      isOptional: true,
    },
    description: "Load config (bunfig.toml)",
  },
  {
    name: ["-y", "--yarn"],
    description: "Write a yarn.lock file (yarn v1)",
  },
  {
    name: ["-p", "--production"],
    description: "Don't install devDependencies",
  },
  {
    name: "--no-save",
    description: "Don't save a lockfile",
  },
  {
    name: "--save",
    description: "Save to package.json",
  },
  {
    name: "--dry-run",
    description: "Don't install anything",
  },
  {
    name: "--frozen-lockfile",
    description: "Disallow changes to lockfile",
  },
  {
    name: ["-f", "--force"],
    description:
      "Always request the latest versions from the registry & reinstall all dependencies",
  },
  {
    name: "--cache-dir",
    args: { name: "path", template: "folders" },
    description: "Store & load cached data from a specific directory path",
  },
  {
    name: "--no-cache",
    description: "Ignore manifest cache entirely",
  },
  {
    name: "--silent",
    description: "Don't log anything",
  },
  {
    name: "--verbose",
    description: "Excessively verbose logging",
  },
  {
    name: ["-g", "--global"],
    description: "Install globally",
  },
  {
    name: "--cwd",
    args: { name: "path", template: "folders" },
    description: "Set a specific cwd",
  },
  {
    name: "--backend",
    args: {
      name: "syscall",
      suggestions: [
        {
          name: "hardlink",
          description: "Default on Linux",
        },
        {
          name: "clonefile",
          description: "Default on macOS",
        },
        {
          name: "clonefile_each_dir",
          description:
            "Similar to clonefile, except it clones each file individually per directory. It is only available on macOS and tends to perform slower than clonefile",
        },
        {
          name: "copyfile",
          description:
            "The fallback used when any of the above fail. It is the slowest option. On macOS, it uses fcopyfile(); on Linux it uses copy_file_range()",
        },
        {
          name: "symlink",
          description:
            "Currently used only for file: (and eventually link:) dependencies. To prevent infinite loops, it skips symlinking the node_modules folder",
        },
      ],
    },
    description:
      "Platform-specific optimizations for installing dependencies. For macOS, 'clonefile' (default), 'copyfile'",
  },
  {
    name: "--link-native-bins",
    args: {
      name: "args",
      isVariadic: true,
    },
    description:
      "Link 'bin' from a matching platform-specific 'optionalDependencies' instead. Default: esbuild, turbo",
  },
  {
    name: "--help",
    description: "Print the help menu",
  },
  {
    name: "--no-progress",
    description: "Disable the progress bar",
  },
  {
    name: "--no-summary",
    description: "Don't print a summary",
  },
  {
    name: "--no-verify",
    description: "Skip verifying integrity of newly downloaded packages",
  },
  {
    name: "--ignore-scripts",
    description:
      "Skip lifecycle scripts in the project's package.json (dependency scripts are never run)",
  },
  {
    name: ["-d", "--dev", "-D", "--development"],
    description: "Install as devDependency",
    priority: 75,
    isRepeatable: false,
  },
  {
    name: "--exact",
    description: "Install exact version",
  },
  {
    name: "--optional",
    description: "Install as optionalDependency",
  },
];

/** Generate the globally linked packages stored in $BUN_INSTALL directory */
const bunLinksGenerator: Fig.Generator = {
  custom: async (_tokens, executeShellCommand, ctx) => {
    const { stdout } = await executeShellCommand({
      command: "find",
      args: [
        `${ctx.environmentVariables["BUN_INSTALL"]}/install/global/node_modules`,
        "-type",
        "l",
      ],
    });

    const links = stdout.split("\n");
    console.log("links", links);
    // Process the output to extract the part after "node_modules/"
    return links.map((link) => {
      const parts = link.split("node_modules/");
      return {
        name: parts[parts.length - 1],
        description:
          "Create a symlink from this pacakage in the global registry to the current project",
        icon: "📦",
      };
    });
  },
};

const spec: Fig.Spec = {
  name: "bun",
  description:
    "A fast bundler, transpiler, JavaScript Runtime and package manager for web software",
  icon,
  args: [
    {
      name: "file",
      generators: [
        // js jsx mjs cjs ts tsx mts cts
        filepaths({ matches: /\.[mc]?[jt]sx?$/ }),
        npmScriptsGenerator,
      ],
    },
    {
      name: "args",
    },
  ],
  // These flags are used before the subcommand or file
  options: publicParams.filter(
    (param) =>
      param.name.includes("--inspect") ||
      param.name.includes("--hot") ||
      param.name.includes("--watch")
  ),
  subcommands: [
    {
      name: ["c", "create"],
      icon,
      description: "Start a new project from a template",
      args: [
        {
          name: "template",
          description: "Package from @bun-examples, GitHub repo, or local file",
          suggestions: [
            "react",
            "next",
            "hono",
            "discord-interactions",
            "blank",
            "bun-bakery",
            ...npxSuggestions
              .filter((bin) =>
                typeof bin.name === "string"
                  ? bin.name.startsWith("create-")
                  : bin.name.some((name) => name.startsWith("create-"))
              )
              .map((bin) => {
                let name = bin.name;
                if (typeof name !== "string") name = name[0];
                name = name.replace(/^create-/, "");

                return { ...bin, name, priority: 76 };
              }),
          ],
          generators: [
            { template: "folders" },
            {
              custom: async (_, executeCommand, context) => {
                const { stdout } = await executeCommand({
                  command: "ls",
                  args: [
                    "-1",
                    `${context.environmentVariables["HOME"]}/.bun-create`,
                  ],
                });
                return stdout.split("\n").map((name) => ({
                  name,
                }));
              },
            },
            { script: ["command", "ls", "-1", ".bun-create"], splitOn: "\n" },
            createCLIsGenerator,
          ],
          loadSpec: async (token) => ({
            name: "create-" + token,
            type: "global",
          }),
          isCommand: true,
        },
        {
          name: "name",
          template: "folders",
          suggestCurrentToken: true,
        },
      ],
      options: [
        { name: "--force", description: "Overwrite existing files" },
        { name: "--no-install", description: "Don't install node_modules" },
        { name: "--no-git", description: "Don't create a git repository" },
        { name: "--verbose", description: "Too many logs" },
        {
          name: "--no-package-json",
          description: "Disable package.json transforms",
        },
        {
          name: "--open",
          description: "On finish, start bun and open in browser",
        },
      ],
    },
    {
      name: "run",
      icon,
      description: "Run a package.json script or executable",
      options: publicParams,
      args: {
        name: "script",
        filterStrategy: "fuzzy",
        generators: [
          filepaths({
            extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
          }),
          npmScriptsGenerator,
        ],
      },
    },
    {
      name: ["i", "install"],
      icon: "📦",
      description: "Install dependencies for a package.json",
      options: dependencyOptions,
    },
    {
      name: ["a", "add"],
      icon: "📦",
      description: "Add a dependency to package.json",
      options: dependencyOptions,
      args: {
        name: "package",
        isVariadic: true,
        debounce: true,
        generators: searchNpmGenerator,
      },
    },
    {
      name: ["rm", "remove"],
      icon: "📦",
      description: "Remove a dependency from package.json",
      options: dependencyOptions,
      args: {
        name: "package",
        filterStrategy: "fuzzy",
        generators: bunDependencyGenerator,
        isVariadic: true,
      },
    },
    {
      name: ["build", "bun"],
      icon,
      description: "Bundle files using Bun's native bundler",
      args: {
        name: "entrypoints",
        isVariadic: true,
        generators: filepaths({
          extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
        }),
        description:
          "Entrypoint to bundle. If multiple entrypoints provided, must specify --outdir",
      },
      options: buildParams,
    },
    {
      name: "update",
      icon,
      description: "Update outdated dependencies",
      options: dependencyOptions,
      args: {
        name: "package",
        filterStrategy: "fuzzy",
        isOptional: true,
        generators: bunDependencyGenerator,
        isVariadic: true,
      },
    },
    {
      name: "link",
      icon: "📦",
      description:
        "Run without an argument to register this package to the global package registry. Uses the name field from package.json",
      args: {
        name: "package",
        filterStrategy: "fuzzy",
        isOptional: true,
        generators: bunLinksGenerator,
        description: "Install a package from the global package registry",
      },
      options: [
        {
          name: "--save",
          description: "Save to package.json",
          dependsOn: ["package"],
        },
      ],
    },
    {
      name: "unlink",
      icon: "📦",
      description: "Unlink this package from the global package registry",
      // Unliking a package by name is not yet implemented. Use bunLinksGenerator once it is implemented.
    },
    {
      name: "upgrade",
      icon,
      description: "Get the latest version of bun",
      options: [
        {
          name: "--canary",
          description: "Install the latest canary release",
        },
      ],
    },
    {
      name: "test",
      icon,
      description: "Run unit tests with Bun",
      args: {
        name: "files",
        generators: {
          // Suggest test files -> https://bun.sh/docs/cli/test. (not in node_modules or .git)
          script: {
            command: "find",
            args: [
              "$(npm prefix)",
              "|",
              "grep",
              "-E",
              '".*.(test|_test|spec|_spec).(ts|tsx|js|jsx)$"',
              "|",
              "grep",
              "-vE",
              ".*/node_modules/.*",
              "|",
              "sed",
              "s|$(npm prefix)/||",
            ],
          },

          postProcess(out) {
            return out.split("\n").map((file) => {
              return {
                name: file.split("/").pop(),
                priority: 76,
                description: `run ${file}`,
                insertValue: file,
              };
            });
          },
          cache: {
            strategy: "stale-while-revalidate",
            ttl: 60 * 60 * 1000, // 1 hour
          },
        },
        isVariadic: true,
        filterStrategy: "fuzzy",
        isOptional: true,
        description: "Test files to run",
      },
      options: testParams,
    },
    {
      name: "pm",
      icon,
      description: "Set of utilities for working with Bun's package manager",
      subcommands: [
        {
          name: "bin",
          description: "Print the path to bin folder",
          options: [
            {
              name: ["-g", "--global"],
              description: "Print the path to the global bin folder",
            },
          ],
        },
        {
          name: "cache",
          description: "Print the path to the cache folder",
          subcommands: [
            {
              name: "rm",
              description: "Clear Bun's global module cache",
            },
          ],
        },
        {
          name: "hash",
          description: "Generate & print the hash of the current lockfile",
        },
        {
          name: "hash-print",
          description: "Print the hash stored in the current lockfile",
        },
        {
          name: "hash-string",
          description: "Print the string used to hash the lockfile",
        },
        {
          name: "ls",
          description:
            "List the dependency tree according to the current lockfile",
          options: [
            {
              name: "--all",
              description:
                "To print all installed dependencies, including nth-order dependencies",
            },
            {
              name: ["-g", "--global"],
              description: "List the global dependency tree",
            },
          ],
        },
      ],
    },
    {
      name: "completions",
      icon,
      description: "Install shell completions",
    },
    {
      name: "discord",
      icon: "fig://icon?type=discord",
      description: "Open bun's Discord server",
    },
    {
      name: "help",
      description: "Print the help menu",
      icon,
    },
    {
      name: "x",
      icon,
      description: "Run an npx command",
      loadSpec: "bunx",
    },
    {
      name: "repl",
      icon,
      description:
        "Run a REPL (read eval print loop) with the Bun runtime.(experimental)",
    },
    {
      name: "init",
      icon,
      description: "Initialize a new bun project",
      options: [
        {
          name: ["-y", "--yes"],
          description: "Answer yes to all prompts",
        },
      ],
    },
  ],
};

export default spec;
