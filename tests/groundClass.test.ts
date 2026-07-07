import { describe, it, expect } from "vitest";
import { groundClass, CITY_VOX } from "../src/build/prefabs";

describe("groundClass — city ground painting", () => {
  it("classifies well beyond the footprint as grass (outside)", () => {
    expect(groundClass(-100, -100)).toBe("outside");
    expect(groundClass(CITY_VOX.x1 + 50, 10)).toBe("outside");
    expect(groundClass(10, CITY_VOX.z1 + 50)).toBe("outside");
  });

  it("puts asphalt streets on the plot boundaries and concrete on the plot interiors", () => {
    // x=0 is a plot boundary → street; a point near a plot centre is a plot apron
    expect(groundClass(0, 30)).toBe("street");
    const PLOT_W = Math.floor(288 / 5); // mirror of prefabs' private constant, for the centre sample
    expect(groundClass(Math.floor(PLOT_W / 2), Math.floor(PLOT_W / 2))).toBe("plot");
  });

  it("covers the whole footprint with pavement (never grass inside the city)", () => {
    let grassInside = 0;
    for (let vx = 0; vx <= CITY_VOX.x1; vx += 4)
      for (let vz = 0; vz <= CITY_VOX.z1; vz += 4)
        if (groundClass(vx, vz) === "outside") grassInside++;
    expect(grassInside).toBe(0);
  });
});
