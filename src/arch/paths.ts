const cache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      const body = glob
        .slice(i + 1, end)
        .split(",")
        .map((p) => globToRegExp(p).source.slice(1, -1));
      out += `(?:${body.join("|")})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!/[*?{]/.test(pattern)) return path === pattern;
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchesAny(
  path: string,
  patterns: readonly string[] | undefined
): boolean {
  return patterns?.some((p) => matchesPattern(path, p)) ?? false;
}
