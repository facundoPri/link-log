export const FAQ = [
  {
    q: "What happens when I save a link?",
    a: "Linklog fetches the preview, reads the page as Markdown (or YouTube captions) and auto tags it from that text.",
  },
  {
    q: "How does auto tagging decide?",
    a: "Each tag has a description and a threshold, 80% to start. All tags are scored in one call and only the ones above their threshold are applied.",
  },
  {
    q: "What is a lens?",
    a: "A question you ask about links or open tabs. It answers yes or no, or picks one of your options. It never changes your tags.",
  },
  {
    q: "Do I need the Chrome extension?",
    a: "No. The library works in any browser. The extension adds the Browser view for your open tabs in desktop Chrome.",
  },
  {
    q: "Who can see my library?",
    a: "Only you. Every library is private to its account, and the extension reads tabs on your machine after you allow it.",
  },
  {
    q: "Is it open source?",
    a: "Yes. The app, the Worker and the extension are in one public GitHub repository.",
  },
];
