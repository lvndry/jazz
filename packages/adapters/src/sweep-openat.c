/* Fixed-arity boundary for openat creation. The platform compiler marshals the
 * variadic mode argument, including Apple's ARM64 stack convention. Calling the
 * supplied libc pointer avoids headers and link-time dependencies on libc. */
typedef int (*JazzOpenAt)(int, const char *, int, ...);
int jazz_openat_create(JazzOpenAt operation, int parent, const char *name, int flags) {
  return operation(parent, name, flags, 0600);
}
