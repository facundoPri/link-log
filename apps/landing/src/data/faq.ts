export const FAQ = [
  {
    q: "What happens when I save a link?",
    a: "Linklog saves it right away, fetches the title, description and preview image, then reads the page as Markdown, or the public captions for a YouTube video. Auto tags and lenses work from that text, so they judge the content and not just the headline.",
  },
  {
    q: "How does auto tagging decide which tags to apply?",
    a: "Every tag has a name, a description written for the model and a confidence threshold that starts at 80%. Linklog scores all your tags for a link in one call and applies the ones that clear their threshold. Every score stays visible in the inspector, including the ones that did not make it.",
  },
  {
    q: "What is a lens?",
    a: "A lens is a question you ask about a set of links or open tabs. It answers yes or no with a confidence, or picks one of your options, with Other always available. Results are stored per link and never change your tags.",
  },
  {
    q: "Do I need the Chrome extension?",
    a: "No. The library works on its own in any modern browser. The extension adds the Browser view in desktop Chrome: the tabs and groups of your current window, Autogroup, lenses on open tabs and closing tabs you already saved.",
  },
  {
    q: "Who can see my library?",
    a: "Only you. Every library is private to its account, and you sign in with email and password or a one time magic link. The extension reads page content locally, and only after you grant access from its Connect page.",
  },
  {
    q: "Does it work with YouTube, X and Instagram?",
    a: "Yes. YouTube videos use their public captions. Public posts on X, Instagram and YouTube keep the author's text and their attachments in order, and text inside images is read automatically. Private content and audio are not processed.",
  },
  {
    q: "What if a page blocks Linklog or asks me to log in?",
    a: "The link is kept. You see a plain reason and a retry button. Login walls and bot checks are detected and never stored as content, and when a page cannot be read at all Linklog falls back to its real title and description.",
  },
  {
    q: "Is Linklog open source?",
    a: "Yes. The app, the Worker and the Chrome extension live in one public repository on GitHub, and each extension release is published there as a zip you can load in Chrome.",
  },
];
