import { Pencil } from 'lucide-react';

export function SpecialistPreview({
  instructions,
  onEdit,
}: {
  instructions: string;
  onEdit?: () => void;
}) {
  return (
    <div className="specialist-preview">
      <p className="specialist-prompt">{instructions}</p>
      {onEdit && (
        <button type="button" className="edit-specialist" onClick={onEdit}>
          <Pencil size={14} />
          Edit specialist
        </button>
      )}
    </div>
  );
}
