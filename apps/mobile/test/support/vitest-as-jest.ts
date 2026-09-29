/**
 * Lets the unchanged @tali/domain kernel suites (which import describe, it and
 * expect from "vitest") run under jest-expo. Only those three names are used
 * by the kernel suites.
 */
const jestDescribe = describe;
const jestIt = it;
const jestExpect = expect;

export { jestDescribe as describe, jestExpect as expect, jestIt as it };
