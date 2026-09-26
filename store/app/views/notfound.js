export default function notfound() {
  document.getElementById("view").innerHTML = `
    <div class="pg nf">
      <h1 class="nf-title">We couldn't find that page.</h1>
      <p class="pg-lede">It may have moved, or the link may be mistyped. Try searching, or start from one of these.</p>
      <form class="nf-search" action="/search" onsubmit="event.preventDefault(); document.getElementById('search').value = this.q.value; document.getElementById('search-form').requestSubmit();">
        <label class="visually-hidden" for="nf-q">Search the store</label>
        <input id="nf-q" name="q" type="search" placeholder="Search coats, knitwear, scarves">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <ul class="nf-links">
        <li><a href="/shop/new">New in</a></li>
        <li><a href="/shop/women">Women</a></li>
        <li><a href="/shop/men">Men</a></li>
        <li><a href="/shop/knitwear">Knitwear</a></li>
        <li><a href="/help">Help centre</a></li>
      </ul>
    </div>`;
  return { title: "Page not found", name: "notfound" };
}
