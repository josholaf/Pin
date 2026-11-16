import { useEffect, useRef, useState, type MouseEvent, type KeyboardEvent, type ClipboardEvent } from "react";
import {
  Moon, Sun, X, Bold, Italic, List, ListOrdered, CheckSquare,
  Heading, Code, TextQuote, Link as LinkIcon, Strikethrough, ArrowLeft,
  Pin, Download, Copy, Table, Highlighter, Palette, ImagePlus, Mic, Square, LayoutGrid, Link2, Maximize2,
  Undo2, Redo2,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { noteToPdf } from "./pdf";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  NOTE_COLORS, ICON_BANK, markdownToHtml, plainToHtml, getIcon, tagColor,
  type Theme, type NoteColor, type AppSettings,
} from "./appData";

// The inline-code toolbar button wraps the selection in backticks; spelled
// out via charCode so this file contains no raw backtick characters.
const BACKTICK = String.fromCharCode(96);
const FENCE = BACKTICK + BACKTICK + BACKTICK;

// v0.1.10: the colored-text snippet. Kept in one place so the toolbar
// button and the slash menu always insert the same thing.
const COLOR_SPAN_OPEN = '<span style="color: #e91e63">';
const COLOR_SPAN_CLOSE = "</span>";

type Props = {
  theme: Theme;
  settings: AppSettings;
  onBack: () => void;
  noteTitle: string;
  setNoteTitle: (v: string) => void;
  noteContent: string;
  setNoteContent: (v: string) => void;
  /** v0.1.37: undo / redo hooks from the editor history in App (issue #47). */
  onUndo?: () => void;
  onRedo?: () => void;
  noteColor: NoteColor;
  setNoteColor: (c: NoteColor) => void;
  noteIcon: string;
  setNoteIcon: (id: string) => void;
  noteFormat: "md" | "txt";
  setNoteFormat: (f: "md" | "txt") => void;
  noteTags: string[];
  /** v0.1.7: every tag used anywhere, for suggestions (issue #18). */
  allTags?: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onPin?: () => void;
  /** Timestamp of the last Ctrl+S save; shows a "Saved" flash (issue #16). */
  savedAt?: number;
  toggleTheme: () => void;
  closeWindow: () => void;
  /** v0.1.14: other notes, for [[wiki-link]] autocomplete (issue #34). */
  allNotes?: { id: string; title: string }[];
  /** v0.1.14: open (or create) the note a [[wiki-link]] points to. */
  onOpenWikiLink?: (title: string) => void;
  /** v0.1.14: notes that link to this one ("Linked mentions"). */
  backlinks?: { id: string; title: string }[];
  /** v0.1.14: open a backlink by id. */
  onOpenNoteById?: (id: string) => void;
};

/** v0.1.9: blocks insertable via the "/" slash menu (issue #22).
 *  `wrap` items place the caret inside the inserted markers.
 *  v0.1.10: `action: "tags"` opens the tag picker instead of inserting (issue #24).
 *  v0.1.11: `action: "image"` opens the photo picker instead of inserting (issue #26). */
type SlashItem = { id: string; label: string; hint: string; md: string; wrap?: boolean; action?: "tags" | "image" };
const SLASH_ITEMS: SlashItem[] = [
  { id: "tags", label: "Tags", hint: "add / remove", md: "", action: "tags" },
  { id: "image", label: "Image", hint: "upload photo", md: "", action: "image" },
  { id: "h1", label: "Heading 1", hint: "#", md: "# " },
  { id: "h2", label: "Heading 2", hint: "##", md: "## " },
  { id: "h3", label: "Heading 3", hint: "###", md: "### " },
  { id: "h4", label: "Heading 4", hint: "####", md: "#### " },
  { id: "task", label: "Task", hint: "Checkbox", md: "- [ ] " },
  { id: "bullet", label: "Bullet list", hint: "List", md: "- " },
  { id: "numbered", label: "Numbered list", hint: "1. 2. 3.", md: "1. " },
  { id: "bold", label: "Bold", hint: "**text**", md: "**text**", wrap: true },
  { id: "italic", label: "Italic", hint: "*text*", md: "*text*", wrap: true },
  { id: "strike", label: "Strikethrough", hint: "~~text~~", md: "~~text~~", wrap: true },
  { id: "highlight", label: "Highlight", hint: "==text==", md: "==text==", wrap: true },
  { id: "color", label: "Colored text", hint: "<span>", md: COLOR_SPAN_OPEN + "text" + COLOR_SPAN_CLOSE },
  { id: "code", label: "Code block", hint: FENCE + "lang", md: FENCE + "python\n\n" + FENCE + "\n" },
  { id: "quote", label: "Quote", hint: ">", md: "> " },
  { id: "table", label: "Table", hint: "| col |", md: "\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n\n" },
  { id: "link", label: "Link", hint: "[text](url)", md: "[text](https://)" },
  { id: "divider", label: "Divider", hint: "---", md: "\n---\n" },
];

export function MarkdownNote(p: Props) {
  const noteEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumRef = useRef<HTMLDivElement | null>(null);
  // v0.1.11: hidden file input for photo uploads (issue #26)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Single-pane auto-preview: rendered view by default; tap/click to edit.
  const [editing, setEditing] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [iconPickerPos, setIconPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const lastSavedAt = useRef<number>(0);
  // v0.1.9: slash command menu (issue #22)
  const [slashMenu, setSlashMenu] = useState<{ top: number; left: number; tokenStart: number } | null>(null);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  // v0.1.14: [[wiki-link]] autocomplete (issue #34)
  const [wikiMenu, setWikiMenu] = useState<{ top: number; left: number; tokenStart: number } | null>(null);
  const [wikiQuery, setWikiQuery] = useState("");
  const [wikiIdx, setWikiIdx] = useState(0);
  // v0.1.10: tag picker opened by the "/tags" slash command (issue #24).
  const [tagPanel, setTagPanel] = useState<{ top: number; left: number } | null>(null);
  const [newTag, setNewTag] = useState("");
  // v0.1.11: photo column picker (1-4 columns) over the selection (issue #26)
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  // v0.1.11: in-note audio recording (issue #26)
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // v0.1.16: focus mode — distraction-free overlay on the open note (issue #38)
  const [focusMode, setFocusMode] = useState(false);
  const focusRef = useRef<HTMLTextAreaElement | null>(null);
  /** v0.1.32: the read-only preview, so the audio player cards can be wired up. */
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  // v0.1.6: flash "Saved" in the status bar after each Ctrl+S save (issue #16)
  useEffect(() => {
    if (p.savedAt && p.savedAt !== lastSavedAt.current) {
      lastSavedAt.current = p.savedAt;
      setFlash("Saved");
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
    }
  }, [p.savedAt]);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const currentColor = NOTE_COLORS.find((c) => c.id === p.noteColor) || NOTE_COLORS[0];
  const bgColor = p.theme === "dark" ? currentColor.dark : currentColor.light;
  const SelectedIcon = getIcon(p.noteIcon).Icon;
  const isMd = p.noteFormat === "md";
  const liveHtml = isMd ? markdownToHtml(p.noteContent) : plainToHtml(p.noteContent);
  const words = p.noteContent.trim() ? p.noteContent.trim().split(/\s+/).length : 0;
  /** v0.1.8: one gutter number per content line, like VS Code (issue #20). */
  const lineCount = p.noteContent.split("\n").length;

  // v0.1.32: wire every audio player card in the preview to its hidden
  // <audio> element — progress fill, time counter and the idle/playing state.
  // The preview re-renders via dangerouslySetInnerHTML, so re-wire on change.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const fmtTime = (t: number) => {
      if (!isFinite(t) || t < 0) return "0:00";
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return m + ":" + String(s).padStart(2, "0");
    };
    root.querySelectorAll<HTMLAudioElement>("audio.md-audio").forEach((a) => {
      const card = a.closest(".md-audio-card") as HTMLElement | null;
      if (!card) return;
      const fill = card.querySelector<HTMLElement>(".md-audio-fill");
      const time = card.querySelector<HTMLElement>(".md-audio-time");
      const update = () => {
        if (fill && a.duration && isFinite(a.duration)) {
          fill.style.width = Math.min(100, (a.currentTime / a.duration) * 100) + "%";
        }
        if (time) time.textContent = fmtTime(a.currentTime);
      };
      const onPlay = () => { card.dataset.state = "playing"; };
      const onPause = () => { card.dataset.state = "paused"; };
      const onEnded = () => {
        card.dataset.state = "idle";
        if (fill) fill.style.width = "0%";
        if (time) time.textContent = "0:00";
      };
      a.addEventListener("timeupdate", update);
      a.addEventListener("play", onPlay);
      a.addEventListener("pause", onPause);
      a.addEventListener("ended", onEnded);
      update();
    });
  }, [liveHtml]);

  /** v0.1.9: slash items matching what was typed after the "/". */
  const slashFiltered = SLASH_ITEMS.filter((it) =>
    !slashQuery ||
    it.label.toLowerCase().includes(slashQuery.toLowerCase()) ||
    it.id.startsWith(slashQuery.toLowerCase())
  );

  /** v0.1.14: note titles matching the [[wiki-link query. */
  const wikiFiltered = (p.allNotes || [])
    .filter((n) => n.title.toLowerCase().includes(wikiQuery.toLowerCase()))
    .slice(0, 8);

  /** Show a short confirmation message in the status bar. */
  const flashMessage = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
  };

  /** Unified export: one entry point for .md / .txt / .pdf (keeps the titlebar clean). */
  const exportAs = async (format: "md" | "txt" | "pdf") => {
    setExportMenuOpen(false);
    try {
      const safe = (p.noteTitle || "note").replace(/[<>:"/\\|?*]+/g, "-").trim() || "note";
      if (format === "pdf") {
        const path = await save({
          defaultPath: safe + ".pdf",
          filters: [{ name: "PDF document", extensions: ["pdf"] }],
        });
        if (!path) return;
        await writeFile(path, noteToPdf(p.noteTitle || "Note", p.noteContent));
        flashMessage("Exported as .pdf");
        return;
      }
      const path = await save({
        defaultPath: safe + "." + format,
        filters: [{ name: format.toUpperCase() + " file", extensions: [format] }],
      });
      if (!path) return;
      await writeTextFile(path, p.noteContent);
      flashMessage("Exported as ." + format);
    } catch {
      flashMessage(format === "pdf" ? "PDF export failed" : "Export failed");
    }
  };

  /** Copy the note body as plain text (issue #7). */
  const copyPlainText = async () => {
    try {
      await navigator.clipboard.writeText(p.noteContent);
      flashMessage("Copied to clipboard");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = p.noteContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        flashMessage("Copied to clipboard");
      } catch { flashMessage("Copy failed"); }
    }
  };
