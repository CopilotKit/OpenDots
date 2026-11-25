import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import { t } from '../i18n';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Code2,
  Undo2,
  Redo2,
  Link2,
} from 'lucide-react';
import { documentExtensions } from './markdown';
import { SlashCommands } from './slash-commands';
import { openPageLink } from '../page-navigation';
export default function RichEditor({
  value,
  onChange,
  onNotice,
}: {
  value: string;
  onChange: (value: string) => void;
  onNotice: (message: string) => void;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const emitted = useRef(value);
  const editor = useEditor({
    extensions: [
      ...documentExtensions(),
      Markdown,
      Placeholder.configure({
        placeholder: t('Start writing, or type / for blocks…'),
      }),
      SlashCommands,
    ],
    content: value,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'document-prose',
        'aria-label': t('Page content'),
        role: 'textbox',
        'aria-multiline': 'true',
      },
      handleClick: (_view, _pos, event) => {
        const target =
          event.target instanceof Element ? event.target.closest('a') : null;
        const href = target?.getAttribute('href');
        if (
          href?.startsWith('/#/spaces/') &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          openPageLink(href);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const html = event.clipboardData?.getData('text/html') ?? '';
        if (/<(img|iframe|script)\b/i.test(html)) {
          event.preventDefault();
          notice.current(
            t(
              'Images and embedded content are not supported here. Use Markdown source to keep their original markup.',
            ),
          );
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      emitted.current = markdown;
      change.current(markdown);
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            bullet: editor.isActive('bulletList'),
            ordered: editor.isActive('orderedList'),
            quote: editor.isActive('blockquote'),
            code: editor.isActive('codeBlock'),
            undo: editor.can().undo(),
            redo: editor.can().redo(),
          }
        : null,
  });
  useEffect(() => {
    if (editor && value !== emitted.current) {
      emitted.current = value;
      editor.commands.setContent(value, {
        contentType: 'markdown',
        emitUpdate: false,
      });
    }
  }, [editor, value]);
  if (!editor) return <div className="editor-loading">Loading editor…</div>;
  const hint = t('Type {key} for blocks · ⌘/Ctrl + S to save').split('{key}');
  return (
    <>
      <div
        className="format-toolbar"
        role="toolbar"
        aria-label={t('Text formatting')}
      >
        <button
          title={t('Bold (⌘/Ctrl B)')}
          aria-label={t('Bold')}
          aria-pressed={state?.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={16} />
        </button>
        <button
          title={t('Italic (⌘/Ctrl I)')}
          aria-label={t('Italic')}
          aria-pressed={state?.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          title={t('Bullet list')}
          aria-label={t('Bullet list')}
          aria-pressed={state?.bullet}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={17} />
        </button>
        <button
          title={t('Numbered list')}
          aria-label={t('Numbered list')}
          aria-pressed={state?.ordered}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={17} />
        </button>
        <button
          title={t('Quote')}
          aria-label={t('Quote')}
          aria-pressed={state?.quote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={15} />
        </button>
        <button
          title={t('Code block')}
          aria-label={t('Code block')}
          aria-pressed={state?.code}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 size={17} />
        </button>
        <button
          title={t('Add link')}
          aria-label={t('Add link')}
          onClick={() => {
            const url = window.prompt(
              t('Link URL (https:// or an internal page link)'),
              editor.getAttributes('link').href ?? '',
            );
            if (url === null) return;
            if (!url) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            if (!/^(https?:\/\/|\/#\/spaces\/)/i.test(url)) {
              onNotice(t('Use a public http(s) URL or an internal page link.'));
              return;
            }
            editor
              .chain()
              .focus()
              .extendMarkRange('link')
              .setLink({ href: url })
              .run();
          }}
        >
          <Link2 size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          aria-label={t('Undo')}
          title={t('Undo')}
          disabled={!state?.undo}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 size={16} />
        </button>
        <button
          aria-label={t('Redo')}
          title={t('Redo')}
          disabled={!state?.redo}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 size={16} />
        </button>
      </div>
      <EditorContent editor={editor} />
      <p className="editor-hint">
        {hint[0]}
        <kbd>/</kbd>
        {hint[1]}
      </p>
    </>
  );
}
