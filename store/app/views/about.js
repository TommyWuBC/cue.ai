import { crumbs } from "../ui.js";
import { PRODUCTS } from "../data.js";
import { esc } from "../util.js";

export default function about() {
  const counts = new Map();
  for (const p of PRODUCTS) {
    const c = p.attrs.origin.replace(/^Made in /, "");
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const origins = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  document.getElementById("view").innerHTML = `
    <div class="pg about">
      ${crumbs([["Home", "/"], ["Our story"]])}
      <h1 class="about-title">We make fewer things, and we make them to be repaired.</h1>
      <figure class="about-hero"><img src="/assets/editorial/about-workshop.jpg" alt="Hands guiding fabric through a sewing machine"></figure>
      <div class="about-cols">
        <section>
          <h2>Materials first</h2>
          <p>Northfield started in 2014 with one coat and a question about why good wool had become so hard to find. We still begin every piece with the cloth: wool from mills that dye the fibre before spinning, cotton that is organic or recycled, leather tanned with bark instead of chrome.</p>
          <p>We would rather tell you exactly what something is made of than call it premium. Every product page lists its full composition, where it was made and how to look after it.</p>
        </section>
        <section>
          <h2>Repairs for life</h2>
          <p>If we made it, we will fix it, free, for as long as you own it. Our studios in London and New York mend around four thousand pieces a year: buttons, seams, zips, linings, worn elbows.</p>
          <p>It keeps clothes out of landfill, and it keeps us honest. Things we have to repair for free are things we make better next time.</p>
          <p><a class="help-link" href="/help/repairs">How repairs work</a></p>
        </section>
      </div>
      <section class="about-origins">
        <h2>Where our current collection is made</h2>
        <p>We work with makers in ${origins.length} countries, each chosen for what it does best.</p>
        <ul>${origins.map(([c, n]) => `<li><span>${esc(c)}</span><span class="tabular">${n} ${n === 1 ? "style" : "styles"}</span></li>`).join("")}</ul>
      </section>
      <section class="about-links">
        <a href="/journal/inside-the-mill"><h3>Inside the mill</h3><p>A day at the Scottish mill that spins our lambswool.</p></a>
        <a href="/stores"><h3>Visit a store</h3><p>London, New York and Copenhagen.</p></a>
      </section>
    </div>`;
  return { title: "Our story", name: "about" };
}
