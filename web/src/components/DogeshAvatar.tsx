import React from 'react';
import { Pencil } from 'lucide-react';

interface DogeshAvatarProps {
  size?: number;
  showEditBadge?: boolean;
  avatarUrl?: string;
  onEditClick?: () => void;
}

export const DogeshAvatar: React.FC<DogeshAvatarProps> = ({
  size = 72,
  showEditBadge = true,
  avatarUrl = '/dogesh.png',
  onEditClick,
}) => {
  return (
    <div
      className="relative inline-block select-none"
      style={{ width: size, height: size }}
    >
      <div
        className="w-full h-full rounded-full overflow-hidden border border-[#2b2a27] shadow-xs bg-white flex items-center justify-center"
      >
        <img
          src={avatarUrl || '/dogesh.png'}
          alt="Dogesh"
          className="w-full h-full object-cover scale-[1.28] translate-y-0.5"
        />
      </div>

      {/* Edit pencil icon badge (bottom right) */}
      {showEditBadge && (
        <button
          type="button"
          onClick={onEditClick}
          title="Edit agent profile"
          className="absolute bottom-0 right-0 w-[21px] h-[21px] rounded-full bg-[#1e1d1b] hover:bg-[#282724] border border-[#33322f] flex items-center justify-center text-white transition-colors cursor-pointer shadow-xs"
        >
          <Pencil size={10.5} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
};
