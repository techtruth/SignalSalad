declare module "minimist" {
  type ParsedArgs = {
    _: Array<string | number>;
    [key: string]: unknown;
  };

  type Options = {
    string?: string | string[];
    boolean?: string | string[];
    alias?: Record<string, string | string[]>;
    default?: Record<string, unknown>;
    unknown?: (arg: string) => boolean;
    stopEarly?: boolean;
    "--"?: boolean;
  };

  function minimist(args: string[], options?: Options): ParsedArgs;

  export default minimist;
}
