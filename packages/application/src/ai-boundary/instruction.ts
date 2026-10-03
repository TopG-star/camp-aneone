declare const INSTRUCTION: unique symbol;

/** Code-written model instructions (D0). Only `instruction` creates one (spec §5.4). */
export type Instruction = string & { readonly [INSTRUCTION]: true };

/**
 * Tagged template for instructions. Substitutions are typed `never`, so interpolating any value
 * fails to compile; a cast around the type still throws here at run time.
 */
export function instruction(strings: TemplateStringsArray, ...values: never[]): Instruction {
  if (values.length > 0) throw new Error("instruction takes no substitutions");
  return strings.join("") as Instruction;
}
