import { describe, it, expect } from "vitest";
import { PlaceholderMap, TOKEN_PATTERN, personEntityId } from "./placeholders.js";

describe("PlaceholderMap", () => {
  it("numbers each entity type from 1 and reuses a token for the same entity", () => {
    const map = new PlaceholderMap();
    expect(map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital")).toBe("CUSTOMER_1");
    expect(map.tokenFor({ type: "customer", id: "c4" }, "Mensah Pharmacy")).toBe("CUSTOMER_2");
    expect(map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital")).toBe("CUSTOMER_1");
    expect(map.tokenFor({ type: "person", id: "ama@x.com" }, "ama@x.com")).toBe("PERSON_1");
    expect(map.size).toBe(3);
  });
  it("starts again at 1 in a new turn, so tokens cannot be linked across turns", () => {
    const a = new PlaceholderMap();
    const b = new PlaceholderMap();
    expect(a.tokenFor({ type: "customer", id: "c9" }, "x")).toBe(b.tokenFor({ type: "customer", id: "other" }, "y"));
  });
  it("refuses an entity type it does not know", () => {
    expect(() => new PlaceholderMap().tokenFor({ type: "patient", id: "p1" }, "x")).toThrow("Unknown entity type");
  });
  it("matches only known token shapes", () => {
    expect("CUSTOMER_1 owes; COVID_19 is not a token; PERSON_12 is".match(TOKEN_PATTERN)).toEqual(["CUSTOMER_1", "PERSON_12"]);
  });
});

describe("personEntityId (final review I1)", () => {
  it("takes the bare address, lowercased, from a Name <addr> header", () => {
    expect(personEntityId("Ama Mensah <Ama@X.com>")).toBe("ama@x.com");
    expect(personEntityId('"Mensah, Ama" <ama@x.com>')).toBe("ama@x.com");
    expect(personEntityId("<ama@x.com>")).toBe("ama@x.com");
  });
  it("uses a bare address as it is", () => {
    expect(personEntityId("ama@x.com")).toBe("ama@x.com");
  });
  it("leaves a value that holds no bracketed address unchanged", () => {
    expect(personEntityId("Ama Mensah")).toBe("Ama Mensah");
    expect(personEntityId("octocat")).toBe("octocat");
  });
});
