// Boutons Enregistrer / Ouvrir du projet (fichier JSON local). Le contenu est produit et lu par src/project/.

export interface ProjectUiContext {
  /** Texte JSON du projet et nom de fichier proposé. */
  snapshot(): { text: string; fileName: string };
  /** Charge un projet ; lève une Error au message lisible si le fichier est refusé. Renvoie les avertissements. */
  load(text: string): string[];
}

export interface ProjectUi {
  save(): Promise<void>;
  open(): void;
  /** Charge un fichier déposé sur la fenêtre. */
  openFile(file: File): Promise<void>;
}

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

export function createProjectUi(root: HTMLElement, ctx: ProjectUiContext): ProjectUi {
  const saveBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Enregistrer', title: 'Enregistrer le projet (Ctrl/Cmd S)' });
  const openBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Ouvrir', title: 'Ouvrir un projet (Ctrl/Cmd O)' });
  const status = Object.assign(document.createElement('div'), { className: 'status' });
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  const row = Object.assign(document.createElement('div'), { className: 'row' });
  row.append(saveBtn, openBtn);
  root.append(row, status, input);

  let timer = 0;
  const say = (msg: string, error = false) => {
    status.textContent = msg;
    status.classList.toggle('err', error);
    clearTimeout(timer);
    if (msg) timer = window.setTimeout(() => { status.textContent = ''; }, error ? 12000 : 5000);
  };

  async function save() {
    const { text, fileName } = ctx.snapshot();
    try {
      const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (picker) {
        // Le sélecteur exige un geste utilisateur : aucun await avant cet appel.
        const handle = await picker({ suggestedName: fileName, types: [{ description: 'Projet SplatCam', accept: { 'application/json': ['.json'] } }] });
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        say(`Enregistré : ${handle.name}`);
      } else {
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: fileName });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        say(`Téléchargé : ${fileName}`);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say(`Enregistrement impossible : ${(e as Error).message}`, true);
    }
  }

  async function openFile(file: File) {
    try {
      const warnings = ctx.load(await file.text());
      say(warnings.length ? `Ouvert : ${file.name}\n${warnings.join('\n')}` : `Ouvert : ${file.name}`);
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  saveBtn.addEventListener('click', () => { void save(); });
  openBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';   // permet de rouvrir le même fichier
    if (f) void openFile(f);
  });
  return { save, open: () => input.click(), openFile };
}
