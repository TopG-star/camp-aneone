import { describe, it, expect } from "vitest";
import { PlaceholderMap } from "./placeholders.js";
import { findRestoredValue } from "./restored-values.js";

const HEADER = "Ama Mensah <ama@x.com>";
const mapWith = (type: string, id: string, display: string) => {
  const map = new PlaceholderMap();
  map.tokenFor({ type, id }, display);
  return map;
};
const sender = () => mapWith("person", "ama@x.com", HEADER);

describe("findRestoredValue", () => {
  it("matches a bare address against a header display", () => {
    expect(findRestoredValue("Reply to ama@x.com today", sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches the header form", () => {
    expect(findRestoredValue(`From: ${HEADER}`, sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches an address in a different case", () => {
    expect(findRestoredValue("AMA@X.COM", sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches a name in a different case", () => {
    expect(findRestoredValue("AMA MENSAH wrote", sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches an address behind leading or trailing punctuation", () => {
    for (const text of ["Reply to _ama@x.com_", "-ama@x.com", "...ama@x.com", "(ama@x.com)", "ama@x.com."]) {
      expect(findRestoredValue(text, sender())).toEqual({ token: "PERSON_1" });
    }
  });
  it("matches a name across double spaces, no-break spaces and newlines", () => {
    for (const text of ["Ama  Mensah wrote", "Ama Mensah wrote", "Ama\nMensah wrote"]) {
      expect(findRestoredValue(text, sender())).toEqual({ token: "PERSON_1" });
    }
  });
  it("matches a person's entity id alone, with a display that is a plain name", () => {
    const map = mapWith("person", "ama@x.com", "Ama Mensah");
    expect(findRestoredValue("write to ama@x.com", map)).toEqual({ token: "PERSON_1" });
    expect(findRestoredValue("write to Ama+x@x.com", map)).toEqual({ token: "PERSON_1" });
  });
  it("matches a non-email person id as text", () => {
    expect(findRestoredValue("user octocat pushed", mapWith("person", "octocat", "The Octocat"))).toEqual({ token: "PERSON_1" });
  });
  it("exempts a non-address form that appears in Oneon-authored text, but never an address", () => {
    const github = mapWith("person", "notifications@github.com", "GitHub <notifications@github.com>");
    expect(findRestoredValue("You have 3 GitHub notifications", github)).toEqual({ token: "PERSON_1" });
    expect(findRestoredValue("You have 3 GitHub notifications", github, "", "- list_github_prs: List GitHub pull requests")).toBeNull();
    expect(findRestoredValue("write notifications@github.com", github, "", "GitHub notifications@github.com")).toEqual({ token: "PERSON_1" });
  });
  it("matches a plus-addressed variant", () => {
    expect(findRestoredValue("Ama+news@X.com wrote", sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches the name part alone inside a longer sentence", () => {
    expect(findRestoredValue("Did anyone hear from Ama Mensah yesterday?", sender())).toEqual({ token: "PERSON_1" });
    expect(findRestoredValue("emails from Ama Mensah yesterday", sender())).toEqual({ token: "PERSON_1" });
  });
  it("matches a quoted name part", () => {
    expect(findRestoredValue("Mensah, Ama wrote", mapWith("person", "ama@x.com", '"Mensah, Ama" <ama@x.com>'))).toEqual({ token: "PERSON_1" });
  });
  it("does not match a substring of another word or address", () => {
    const ama = mapWith("person", "p1", "Ama");
    expect(findRestoredValue("Amazon shipped it", ama)).toBeNull();
    expect(findRestoredValue("bob.ama@x.com wrote", sender())).toBeNull();
    expect(findRestoredValue("xama@x.com wrote", sender())).toBeNull();
  });
  it("exempts a form the person typed, per form", () => {
    expect(findRestoredValue("ama@x.com wrote", sender(), "did ama@x.com email me?")).toBeNull();
    expect(findRestoredValue("Ama+tag@x.com wrote", sender(), "did AMA@x.com email me?")).toBeNull();
    expect(findRestoredValue("Ama Mensah wrote", sender(), "what did Ama Mensah say?")).toBeNull();
    // Typing the address does not exempt the name.
    expect(findRestoredValue("Ama Mensah wrote", sender(), "did ama@x.com email me?")).toEqual({ token: "PERSON_1" });
    // Typing the name does not exempt the address.
    expect(findRestoredValue("ama@x.com wrote", sender(), "what did Ama Mensah say?")).toEqual({ token: "PERSON_1" });
  });
  it("does not match a customer or supplier id", () => {
    expect(findRestoredValue("c123 and s456 and the id c123", mapWith("customer", "c123", "ABC Hospital"))).toBeNull();
    expect(findRestoredValue("abc hospital owes", mapWith("customer", "c9", "ABC Hospital"))).toEqual({ token: "CUSTOMER_1" });
  });
  it("ignores forms under 3 characters and a purely numeric name part", () => {
    expect(findRestoredValue("Al spoke", mapWith("person", "al@x.com", "Al <al@x.com>"))).toBeNull();
    expect(findRestoredValue("call 12345 now", mapWith("person", "n@x.com", "12345 <n@x.com>"))).toBeNull();
  });
  it("returns only the token", () => {
    expect(Object.keys(findRestoredValue("ama@x.com", sender())!)).toEqual(["token"]);
  });
  it("returns null when nothing matches", () => {
    expect(findRestoredValue("nothing here", sender())).toBeNull();
  });
});
