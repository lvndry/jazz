interface SessionLine {
  glyphClass: string;
  glyph: string;
  text: string;
  dim?: string;
  typed?: boolean;
  plain?: boolean;
  delay?: number;
  approval?: boolean;
}

const SCRIPT: SessionLine[] = [
  {
    glyphClass: "g-user",
    glyph: "»",
    text: " plan my morning: email, calendar, weather",
    typed: true,
  },
  {
    glyphClass: "g-ok",
    glyph: "╺",
    text: " gmail.search",
    dim: " — 14 unread, 3 need you",
    delay: 900,
  },
  {
    glyphClass: "g-ok",
    glyph: "╺",
    text: " calendar.today",
    dim: " — 4 events, first at 09:30",
    delay: 700,
  },
  {
    glyphClass: "g-ok",
    glyph: "╺",
    text: " weather.now",
    dim: " — 18°C, rain after 14:00",
    delay: 600,
  },
  {
    glyphClass: "g-agent",
    glyph: "╶",
    text: " Three emails matter: the contract redline,",
    plain: true,
    delay: 800,
  },
  {
    glyphClass: "g-agent",
    glyph: " ",
    text: "  Ana's question, and the invoice. Your 09:30",
    plain: true,
    delay: 300,
  },
  {
    glyphClass: "g-agent",
    glyph: " ",
    text: "  clashes with the dentist — want me to move it?",
    plain: true,
    delay: 300,
  },
  {
    glyphClass: "g-ask",
    glyph: "▐",
    text: ' reschedule "design sync" → 11:00',
    delay: 1100,
    approval: true,
  },
  { glyphClass: "g-ok", glyph: "╺", text: " approved — moved. Bring an umbrella.", delay: 2600 },
];

const STATES = [
  "idle",
  "reading mail…",
  "reading calendar…",
  "checking weather…",
  "thinking…",
  "thinking…",
  "thinking…",
  "asking you",
  "done",
];

export function runSession(body: HTMLElement, doing: HTMLElement, approval: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let started = false;

  const play = (): void => {
    body.innerHTML = "";
    approval.classList.remove("armed");
    let index = 0;

    const nextLine = (): void => {
      if (index >= SCRIPT.length) {
        setTimeout(play, 8000);
        return;
      }
      const line = SCRIPT[index]!;
      doing.textContent = STATES[Math.min(index, STATES.length - 1)] ?? "";
      const element = document.createElement("div");
      element.className = "tl";
      const glyph = `<span class="${line.glyphClass}">${line.glyph}</span>`;

      if (line.typed && !reduced) {
        element.innerHTML = `${glyph}<span class="txt"></span><span class="cursor"></span>`;
        body.appendChild(element);
        const target = element.querySelector(".txt")!;
        let position = 0;
        const typer = setInterval(() => {
          position++;
          target.textContent = line.text.slice(0, position);
          if (position >= line.text.length) {
            clearInterval(typer);
            element.querySelector(".cursor")?.remove();
            index++;
            setTimeout(nextLine, 500);
          }
        }, 34);
        return;
      }

      const textClass = line.plain ? "dim" : "txt";
      element.innerHTML =
        `${glyph}<span class="${textClass}">${line.text}</span>` +
        (line.dim ? `<span class="mut">${line.dim}</span>` : "");
      body.appendChild(element);
      if (line.approval) {
        setTimeout(() => approval.classList.add("armed"), 600);
      }
      index++;
      setTimeout(nextLine, reduced ? 60 : (line.delay ?? 500));
    };

    nextLine();
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !started) {
        started = true;
        play();
        observer.disconnect();
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(body);
}
