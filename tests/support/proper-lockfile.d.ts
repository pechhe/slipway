// The slice of proper-lockfile (untyped) that tests use to hold a real lock.
declare module "proper-lockfile" {
  const lockfile: {
    lock(file: string, options?: { realpath?: boolean; stale?: number; update?: number }): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
