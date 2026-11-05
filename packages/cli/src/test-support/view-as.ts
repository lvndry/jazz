/**
 * Reads an object through a type it does not declare: a stand-in handed to code that wants the
 * full type, or a real object whose private members a test needs to reach. The caller names the
 * view and takes responsibility that the members it touches exist.
 */
export function viewAs<View extends object>(subject: object): View {
  return subject as View;
}
