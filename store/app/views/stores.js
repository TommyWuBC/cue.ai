import { crumbs } from "../ui.js";

const STORES = [
  { city: "London", image: "store-london", address: ["14 Lamb's Conduit Street", "London WC1N 3LE"], phone: "+44 20 7946 0321",
    hours: [["Monday to Friday", "10am to 7pm"], ["Saturday", "10am to 6pm"], ["Sunday", "12pm to 5pm"]],
    services: ["Repair studio", "Alterations", "Store pickup"] },
  { city: "New York", image: "store-new-york", address: ["211 Elizabeth Street", "New York, NY 10012"], phone: "+1 (212) 555 0187",
    hours: [["Monday to Saturday", "11am to 8pm"], ["Sunday", "12pm to 6pm"]],
    services: ["Repair studio", "Tailoring by appointment", "Store pickup"] },
  { city: "Copenhagen", image: "store-copenhagen", address: ["Jægersborggade 31", "2200 København N"], phone: "+45 32 12 48 60",
    hours: [["Monday to Friday", "11am to 6pm"], ["Saturday", "10am to 4pm"], ["Sunday", "Closed"]],
    services: ["Alterations", "Store pickup"] },
];

export default function stores() {
  document.getElementById("view").innerHTML = `
    <div class="pg">
      ${crumbs([["Home", "/"], ["Stores"]])}
      <h1 class="pg-title">Stores</h1>
      <p class="pg-lede">Three shops, each with space to try things on properly. Online orders can be collected and returned at any of them.</p>
      <div class="store-list">${STORES.map(s => `
        <section class="store">
          <div class="store-media"><img src="/assets/editorial/${s.image}.jpg" alt="" loading="lazy"></div>
          <div class="store-info">
            <h2>${s.city}</h2>
            <address>${s.address.join("<br>")}<br>${s.phone}</address>
            <table class="store-hours"><tbody>${s.hours.map(([d, h]) => `<tr><th scope="row">${d}</th><td>${h}</td></tr>`).join("")}</tbody></table>
            <ul class="store-services">${s.services.map(x => `<li>${x}</li>`).join("")}</ul>
            <a class="btn btn-secondary" href="https://maps.google.com/?q=${encodeURIComponent(s.address.join(", "))}" target="_blank" rel="noopener">Get directions</a>
          </div>
        </section>`).join("")}</div>
    </div>`;
  return { title: "Stores", name: "stores" };
}
