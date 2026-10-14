export type FakeRoot = {
  dataset: Record<string, string>;
  style: { colorScheme: string; vars: Map<string, string>; setProperty: (k: string, v: string) => void; removeProperty: (k: string) => string };
};

/** Stands in for `document.documentElement`, recording inline custom properties in `style.vars`. */
export function fakeRoot(): FakeRoot {
  const vars = new Map<string, string>();
  return {
    dataset: {},
    style: { colorScheme: "", vars, setProperty: (k, v) => void vars.set(k, v), removeProperty: (k) => (vars.delete(k), "") },
  };
}
