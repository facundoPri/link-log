/** Rises and fades sections in as they enter the viewport, once each. */
export function initReveal() {
  const items = document.querySelectorAll<HTMLElement>("[data-reveal]");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
  );
  items.forEach((el) => io.observe(el));
}
