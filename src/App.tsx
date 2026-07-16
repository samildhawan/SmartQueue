import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  ArrowLeft, 
  CheckCircle2, 
  Clock, 
  Users, 
  MessageSquare, 
  X, 
  AlertTriangle, 
  Edit2, 
  Trash2,
  ChevronRight,
  LogOut,
  MapPin,
  User as UserIcon,
  LogIn,
  Loader2,
  AlertCircle,
  GripVertical,
  Building2,
  UserPlus,
  Copy,
  Hash
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { NOISE_PIN } from './ticket-clustering';
import { connectTicketsHub } from './realtimeHub';
import { 
  auth, 
  db, 
  loginWithEmail,
  registerWithEmail,
  logout, 
  onAuthStateChanged, 
  onSnapshot, 
  collection, 
  query, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  serverTimestamp,
  where,
  getDocs,
  Timestamp,
  User,
  OperationType,
  handleFirestoreError,
  UserProfile,
  getUserProfile,
  createUserProfile,
  createSchool,
  getSchool,
  generateSchoolId
 } from './firebase';
  import { useTicketClusters } from './useTicketClusters';

type Screen = 'LOGIN' | 'REGISTER' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'TA_DASHBOARD' | 'TA_SESSION_DETAIL' | 'TA_TICKET_DETAIL' | 'TA_SESSION_LIVE';

interface Ticket {
    id: string;
    topic: string;
    assignment: string;
    summary: string;
    helpType: string;
    uid: string;
    createdAt: any;
    status: 'active' | 'resolved' | 'archived';
    taExplanation?: string;
    resolvedAt?: any;
    attendanceMode?: 'in-person' | 'online';
    pinnedToTicketId?: string | null;
  }

interface Session {
  id: string;
  course: string;
  title: string;
  time: string;
  location: string;
  host: string;
  avgMin: number;
  tags: string[];
  tickets: Ticket[];
  queueCount: number;
  estWait: number;
  estimatedWait: number;
  status: 'upcoming' | 'live' | 'archived';
  assignments?: string[];
}

// Course-specific assignment mappings
const COURSE_ASSIGNMENTS: Record<string, string[]> = {
  'CSC369': ['Assignment 1', 'Assignment 2', 'Assignment 3', 'Assignment 4', 'Midterm', 'Final Exam'],
  'STA355': ['Problem Set 1', 'Problem Set 2', 'Problem Set 3', 'Problem Set 4', 'Midterm', 'Final Exam'],
  'MAT237': ['Problem Set 1', 'Problem Set 2', 'Problem Set 3', 'Term Test 1', 'Term Test 2', 'Final Exam'],
};
const DEFAULT_ASSIGNMENTS = ['Assignment 1', 'Assignment 2', 'Assignment 3', 'Midterm'];

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const errorData = JSON.parse(this.state.error.message);
        if (errorData.error && errorData.error.includes("insufficient permissions")) {
          errorMessage = "You don't have permission to perform this action. Please check your login status.";
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center border border-error/20">
            <AlertTriangle className="w-16 h-16 text-error mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-dark mb-4">Application Error</h2>
            <p className="text-gray-medium mb-8">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-primary text-white font-bold rounded-lg hover:bg-primary-hover transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

interface TicketDetailModalProps {
  ticket: Ticket;
  position: number;
  isCurrentlyActive: boolean;
  isPinned: boolean;
  clusterLabel?: string;          // present if ticket is in a cluster
  clusterMemberCount: number;      // total tickets in same cluster (1 if standalone)
  onClose: () => void;
  onMakeActive: () => Promise<void>;
  onUnpin?: () => Promise<void>;
  onResolveOne: (explanation: string) => Promise<void>;
  onResolveCluster: (explanation: string) => Promise<void>;
}

const TicketDetailModal: React.FC<TicketDetailModalProps> = ({
  ticket,
  position,
  isCurrentlyActive,
  isPinned,
  clusterLabel,
  clusterMemberCount,
  onClose,
  onMakeActive,
  onUnpin,
  onResolveOne,
  onResolveCluster,
}) => {
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const inCluster = clusterMemberCount > 1;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);

  const guarded = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onClose();
    } catch (err) {
      console.error('Action failed:', err);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="bg-primary-light/30 px-6 py-4 flex items-center justify-between border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-gray-medium font-bold">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-medium">
              {isCurrentlyActive ? 'Now answering' : `Position #${position}`}
            </span>
            {inCluster && clusterLabel && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                · {clusterLabel}
              </span>
            )}
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 hover:bg-white/60 rounded text-gray-medium disabled:opacity-50" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="text-lg font-bold text-dark">Student {ticket.uid.substring(0, 4).toUpperCase()}</h3>
              {ticket.attendanceMode && (
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                  {ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}
                </span>
              )}
              {isPinned && (
                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Pinned</span>
              )}
              {isCurrentlyActive && (
                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary text-white">Active</span>
              )}
            </div>
            <p className="text-xs text-gray-medium uppercase font-bold tracking-wider">
              {ticket.topic} · {ticket.assignment} · {ticket.helpType}
            </p>
          </div>
          <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 italic text-dark leading-relaxed text-sm whitespace-pre-wrap break-words">
            {ticket.summary
              ? <>&ldquo;{ticket.summary}&rdquo;</>
              : <span className="text-gray-medium not-italic">No description provided.</span>}
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-gray-medium uppercase tracking-widest">
              TA Response / Explanation {inCluster ? '(applied to all in cluster if you Resolve All)' : '(optional)'}
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Optional — type your explanation here..."
              className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all min-h-[80px] resize-none text-sm"
              disabled={busy}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 space-y-3 shrink-0">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              {isPinned && onUnpin && (
                <button
                  onClick={guarded(onUnpin)}
                  disabled={busy}
                  className="text-xs font-bold text-amber-700 uppercase hover:underline disabled:opacity-50"
                >
                  Unpin
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="px-3 py-2 text-sm font-bold text-gray-medium hover:text-dark transition-colors disabled:opacity-50"
              >
                Close
              </button>
              {!isCurrentlyActive && (
                <button
                  onClick={guarded(onMakeActive)}
                  disabled={busy}
                  className="px-3 py-2 text-sm font-bold rounded-lg bg-gray-100 text-dark hover:bg-gray-200 transition-all active:scale-95 disabled:opacity-50"
                  title="Move this ticket to position #1 so you can answer it now"
                >
                  Make Active
                </button>
              )}
            </div>
          </div>
          {inCluster ? (
            <>
              <button
                onClick={guarded(() => onResolveCluster(explanation))}
                disabled={busy}
                className="w-full py-3 bg-primary text-white text-sm font-bold rounded-xl shadow hover:bg-primary-hover transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                Resolve All {clusterMemberCount} Tickets in Cluster
              </button>
              <button
                onClick={guarded(() => onResolveOne(explanation))}
                disabled={busy}
                className="w-full text-xs text-gray-medium hover:text-dark hover:underline transition-colors disabled:opacity-50"
              >
                Or, resolve only this ticket
              </button>
            </>
          ) : (
            <button
              onClick={guarded(() => onResolveOne(explanation))}
              disabled={busy}
              className="w-full py-3 bg-primary text-white text-sm font-bold rounded-xl shadow hover:bg-primary-hover transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              Resolve Ticket
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface ResolveClusterDialogProps {
  clusterLabel: string;
  memberCount: number;
  onConfirm: (explanation: string) => Promise<void>;
  onCancel: () => void;
}

const ResolveClusterDialog: React.FC<ResolveClusterDialogProps> = ({ clusterLabel, memberCount, onConfirm, onCancel }) => {
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel, busy]);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(explanation);
    } catch (err) {
      console.error('Resolve cluster failed:', err);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-dark">Resolve all {memberCount} tickets?</h3>
            <p className="text-xs text-gray-medium">Cluster: <span className="font-bold">{clusterLabel}</span></p>
          </div>
        </div>
        <p className="text-sm text-dark mb-4">
          All {memberCount} tickets in this cluster will be marked resolved. The same explanation will be saved on each.
        </p>
        <div className="space-y-2 mb-5">
          <label className="text-[10px] font-bold text-gray-medium uppercase tracking-widest">
            Shared Explanation (optional)
          </label>
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="Optional — type your explanation here. It will be saved on every ticket in the cluster."
            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all min-h-[80px] resize-none text-sm"
            disabled={busy}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm font-bold text-gray-medium hover:text-dark transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Resolve All {memberCount}
          </button>
        </div>
      </div>
    </div>
  );
};

interface SortableClusterTicketProps {
  ticket: Ticket;
  position: number;     // 1-indexed queue position across all active tickets
  isPinned: boolean;
  isCurrentlyActive: boolean;
  onUnpin?: () => void;
  onClick?: () => void;
}

const SortableClusterTicket: React.FC<SortableClusterTicketProps> = ({ ticket, position, isPinned, isCurrentlyActive, onUnpin, onClick }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ticket.id, data: { type: 'ticket', ticketId: ticket.id } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  // Click on the row body opens details. We stopPropagation on the drag
  // handle and unpin button so they don't also open the modal.
  const handleRowClick = () => {
    if (isDragging) return;
    onClick?.();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`px-5 py-4 flex items-center justify-between bg-white border-b border-gray-100 last:border-b-0 ${isDragging ? 'shadow-lg ring-2 ring-primary/20' : ''} ${isCurrentlyActive ? 'bg-primary-light/30' : ''} ${onClick ? 'hover:bg-gray-50 cursor-pointer' : ''} transition-colors`}
      onClick={handleRowClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab active:cursor-grabbing p-1 hover:bg-gray-100 rounded text-gray-300 hover:text-gray-500 transition-colors shrink-0"
          aria-label="Drag ticket"
        >
          <GripVertical className="w-4 h-4" />
        </div>
        <span className="text-xs font-mono text-gray-medium shrink-0">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-dark text-sm">Student {ticket.uid.substring(0, 4).toUpperCase()}</span>
            {ticket.attendanceMode && (
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                {ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}
              </span>
            )}
            {isPinned && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title="This ticket was manually placed in this cluster">
                Pinned
              </span>
            )}
            {isCurrentlyActive && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary text-white">
                Active
              </span>
            )}
          </div>
          <span className="text-xs text-gray-medium truncate block">{ticket.topic} · {ticket.assignment} · {ticket.helpType}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {isPinned && onUnpin && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnpin(); }}
            className="text-[10px] font-bold text-amber-700 uppercase tracking-wider hover:underline"
            title="Remove manual pin and let the algorithm decide"
          >
            Unpin
          </button>
        )}
        <span className="text-[10px] font-bold text-gray-medium uppercase">
          {isCurrentlyActive ? 'Now' : `#${position}`}
        </span>
      </div>
    </div>
  );
};

interface DroppableClusterZoneProps {
  clusterKey: string;       // unique drop target id (e.g. "cluster-3" or "noise")
  label: string;
  isOver?: boolean;
}

const DroppableClusterZone: React.FC<DroppableClusterZoneProps> = ({ clusterKey, label }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `dropzone-${clusterKey}`,
    data: { type: 'cluster-zone', clusterKey },
  });

  return (
    <div
      ref={setNodeRef}
      className={`px-5 py-2 text-center text-[10px] font-bold uppercase tracking-widest transition-all ${isOver ? 'bg-primary/10 text-primary border-t-2 border-primary border-dashed' : 'bg-gray-50 text-gray-medium border-t border-gray-100'}`}
    >
      {isOver ? `Drop to add to ${label}` : `Drop here to add to this group`}
    </div>
  );
};

interface ClusterDragViewProps {
  session: Session;
  activeTickets: Ticket[];
  clusterResult: any; // ClusterResult from useTicketClusters
  clustersLoading: boolean;
  sensors: any;
  onMoveTicketBetweenClusters: (ticketId: string, targetClusterKey: string, newPositionMs: number) => Promise<void>;
  onReorderWithinCluster: (ticketId: string, newCreatedAtMs: number) => Promise<void>;
  onMoveCluster: (memberIds: string[], baseCreatedAtMs: number) => Promise<void>;
  onUnpin: (ticketId: string) => Promise<void>;
  onMakeActive: (ticketId: string) => Promise<void>;
  onResolveTickets: (ticketIds: string[], explanation: string) => Promise<void>;
}

const ClusterDragView: React.FC<ClusterDragViewProps> = ({
  session,
  activeTickets,
  clusterResult,
  clustersLoading,
  sensors,
  onMoveTicketBetweenClusters,
  onReorderWithinCluster,
  onMoveCluster,
  onUnpin,
  onMakeActive,
  onResolveTickets,
}) => {
  // Build display order: clusters sorted by their earliest member's createdAt
  const displayOrder = useMemo(() => {
    if (!clusterResult) return { clusters: [], noise: [] };
    const ticketTime = (t: Ticket) => t.createdAt?.toDate?.()?.getTime() ?? 0;
    const clustersWithTime = clusterResult.clusters.map((c: any) => {
      const members = c.ticketIds
        .map((id: string) => session.tickets.find(t => t.id === id))
        .filter((t: Ticket | undefined): t is Ticket => !!t)
        .sort((a: Ticket, b: Ticket) => ticketTime(a) - ticketTime(b));
      return {
        ...c,
        members,
        earliestTime: members.length > 0 ? ticketTime(members[0]) : Infinity,
      };
    }).sort((a: any, b: any) => a.earliestTime - b.earliestTime);

    const noiseMembers = clusterResult.noiseTicketIds
      .map((id: string) => session.tickets.find(t => t.id === id))
      .filter((t: Ticket | undefined): t is Ticket => !!t)
      .sort((a: Ticket, b: Ticket) => ticketTime(a) - ticketTime(b));

    return { clusters: clustersWithTime, noise: noiseMembers };
  }, [clusterResult, session.tickets]);

  // Position lookup: ticket id -> 1-indexed queue position across all active tickets
  const positionByTicket = useMemo(() => {
    const m = new Map<string, number>();
    activeTickets.forEach((t, idx) => m.set(t.id, idx + 1));
    return m;
  }, [activeTickets]);

  // Mixed top-level queue: clusters and individual (noise) tickets interleaved
  // by createdAt. Each item is either a cluster card or a single noise ticket.
  const queueItems = useMemo(() => {
    const ticketTime = (t: Ticket) => t.createdAt?.toDate?.()?.getTime() ?? 0;
    type Item =
      | { type: 'cluster'; data: any; sortTime: number; sortId: string }
      | { type: 'ticket'; data: Ticket; sortTime: number; sortId: string };
    const items: Item[] = [];
    for (const cluster of displayOrder.clusters) {
      items.push({
        type: 'cluster',
        data: cluster,
        sortTime: cluster.earliestTime,
        sortId: `cluster-header-${cluster.representativeTicketId}`,
      });
    }
    for (const ticket of displayOrder.noise) {
      items.push({
        type: 'ticket',
        data: ticket,
        sortTime: ticketTime(ticket),
        sortId: ticket.id,
      });
    }
    items.sort((a, b) => a.sortTime - b.sortTime);
    return items;
  }, [displayOrder]);

  // Outer SortableContext items — cluster-header ids + noise ticket ids in queue order.
  // Each cluster card hosts its OWN inner SortableContext for its members.
  const outerSortIds = useMemo(() => queueItems.map(i => i.sortId), [queueItems]);

  // Currently-active ticket = the one being answered (first in queue order).
  const currentlyActiveId = activeTickets[0]?.id ?? null;

  // Set of ticket ids that have a manual cluster pin.
  const pinnedTicketIds = useMemo(
    () => new Set(session.tickets.filter(t => !!t.pinnedToTicketId).map(t => t.id)),
    [session.tickets]
  );

  // Modal state — detail view (per-ticket inspection / actions)
  const [detailTicketId, setDetailTicketId] = useState<string | null>(null);

  // Auto-close detail modal if the ticket leaves the active set (e.g. got resolved
  // by another TA or by the resolve action itself).
  useEffect(() => {
    if (detailTicketId && !activeTickets.some(t => t.id === detailTicketId)) {
      setDetailTicketId(null);
    }
  }, [detailTicketId, activeTickets]);

  // Lookup helpers used by the detail modal
  const detailTicket = detailTicketId ? activeTickets.find(t => t.id === detailTicketId) ?? null : null;
  const detailClusterContext = useMemo(() => {
    if (!detailTicket) return null;
    const inCluster = displayOrder.clusters.find((c: any) =>
      c.members.some((m: Ticket) => m.id === detailTicket.id)
    );
    if (inCluster) {
      return {
        label: inCluster.label as string,
        memberIds: inCluster.members.map((m: Ticket) => m.id) as string[],
      };
    }
    return { label: 'Individual', memberIds: [detailTicket.id] };
  }, [detailTicket, displayOrder]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const overData = over.data.current;
    const activeId = String(active.id);
    const overId = String(over.id);

    const ticketTime = (t: Ticket) => t.createdAt?.toDate?.()?.getTime() ?? 0;

    // Classify the active item
    const activeIsCluster = activeId.startsWith('cluster-header-');
    const activeIsNoise = !activeIsCluster && displayOrder.noise.some((t: Ticket) => t.id === activeId);
    const activeMemberCluster = activeIsCluster || activeIsNoise
      ? null
      : displayOrder.clusters.find((c: any) => c.members.some((m: Ticket) => m.id === activeId));
    const activeIsMember = !!activeMemberCluster;

    // Classify the drop target
    const overIsClusterHeader = overId.startsWith('cluster-header-');
    const overIsZone = overData?.type === 'cluster-zone';
    const overIsNoise = !overIsClusterHeader && !overIsZone && displayOrder.noise.some((t: Ticket) => t.id === overId);
    const overMemberCluster = overIsClusterHeader || overIsZone || overIsNoise
      ? null
      : displayOrder.clusters.find((c: any) => c.members.some((m: Ticket) => m.id === overId));
    const overIsMember = !!overMemberCluster;

    // ────────────────────────────────────────────────────────────────────────
    // Top-level reorder: a cluster or an individual ticket dropped on
    // another cluster header / individual ticket. Rewrites timestamps for all
    // top-level items in the new order.
    // ────────────────────────────────────────────────────────────────────────
    const isTopLevelReorder =
      (activeIsCluster || activeIsNoise) && (overIsClusterHeader || overIsNoise);

    if (isTopLevelReorder) {
      const oldIdx = queueItems.findIndex(i => i.sortId === activeId);
      const newIdx = queueItems.findIndex(i => i.sortId === overId);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(queueItems, oldIdx, newIdx);

      // Anchor the rewrite at the earliest existing timestamp so we don't
      // shift the queue forward in time on every drag.
      const earliest = Math.min(
        ...reordered.map(i => i.sortTime).filter((t: number) => isFinite(t))
      );
      let cursor = isFinite(earliest) ? earliest : Date.now();
      for (const item of reordered) {
        if (item.type === 'cluster') {
          const memberIds = item.data.members.map((m: Ticket) => m.id);
          await onMoveCluster(memberIds, cursor);
          cursor += memberIds.length * 100 + 1000;
        } else {
          await onReorderWithinCluster(item.data.id, cursor);
          cursor += 1000;
        }
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Member dragged onto something OUTSIDE its cluster → unpin and place
    // at the top level (above the target cluster header / next to the noise).
    // ────────────────────────────────────────────────────────────────────────
    if (activeIsMember && (overIsClusterHeader || overIsNoise)) {
      // Compute createdAt: just before the over-item in the queue
      const overItem = queueItems.find(i => i.sortId === overId);
      if (!overItem) return;

      // Find the previous item's "end time" so we slot in between
      const overItemIdx = queueItems.findIndex(i => i.sortId === overId);
      const prevItem = overItemIdx > 0 ? queueItems[overItemIdx - 1] : null;
      const prevEndTime = prevItem
        ? (prevItem.type === 'cluster'
            ? Math.max(...prevItem.data.members.map((m: Ticket) => ticketTime(m)))
            : ticketTime(prevItem.data))
        : overItem.sortTime - 2000;
      const newCreatedAtMs = (prevEndTime + overItem.sortTime) / 2;

      // 'unpin' clears pinnedToTicketId AND sets createdAt
      await onMoveTicketBetweenClusters(activeId, 'unpin', newCreatedAtMs);
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Ticket-level drop into a cluster (active = noise OR member; over =
    // cluster member or cluster zone).
    // ────────────────────────────────────────────────────────────────────────
    if (!activeIsCluster && (overIsMember || overIsZone)) {
      const draggedTicketId = activeId;
      const draggedTicket = session.tickets.find(t => t.id === draggedTicketId);
      if (!draggedTicket) return;

      // Determine destination cluster
      let destClusterKey: string;
      let destNeighborId: string | null = null;

      if (overIsZone) {
        destClusterKey = overData.clusterKey;
      } else {
        // overIsMember
        destClusterKey = `cluster-${overMemberCluster.representativeTicketId}`;
        destNeighborId = overId;
      }

      // Compute new createdAt
      const destCluster = displayOrder.clusters.find(
        (c: any) => `cluster-${c.representativeTicketId}` === destClusterKey
      );

      let newCreatedAtMs: number;
      if (destNeighborId && destCluster) {
        const neighborTicket = session.tickets.find(t => t.id === destNeighborId);
        const neighborTime = neighborTicket ? ticketTime(neighborTicket) : Date.now();
        const idx = destCluster.members.findIndex((m: Ticket) => m.id === destNeighborId);
        const nextMember = destCluster.members[idx + 1];
        const nextTime = nextMember ? ticketTime(nextMember) : neighborTime + 2000;
        newCreatedAtMs = (neighborTime + nextTime) / 2;
      } else if (destCluster) {
        const lastMember = destCluster.members[destCluster.members.length - 1];
        newCreatedAtMs = lastMember ? ticketTime(lastMember) + 1000 : Date.now();
      } else {
        newCreatedAtMs = Date.now();
      }

      // Same cluster (reorder) vs cross-cluster (re-pin)
      const sourceClusterKey = activeMemberCluster
        ? `cluster-${activeMemberCluster.representativeTicketId}`
        : null;

      if (sourceClusterKey === destClusterKey) {
        await onReorderWithinCluster(draggedTicketId, newCreatedAtMs);
      } else {
        await onMoveTicketBetweenClusters(draggedTicketId, destClusterKey, newCreatedAtMs);
      }
      return;
    }
  };

  if (clustersLoading && !clusterResult) {
    return (
      <div className="text-center py-12 text-gray-medium bg-white rounded-2xl border-2 border-dashed border-gray-200">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
        <p className="text-sm">Warming up clustering model...</p>
        <p className="text-xs mt-1 opacity-70">~14MB, cached after first load</p>
      </div>
    );
  }

  if (!clusterResult || (displayOrder.clusters.length === 0 && displayOrder.noise.length === 0)) {
    return (
      <div className="text-center py-12 bg-white rounded-2xl border-2 border-dashed border-gray-200">
        <p className="text-gray-medium">Queue is empty.</p>
      </div>
    );
  }

  return (
    <>
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      {/* Single top-level sortable: cluster cards and individual tickets
          interleaved by queue order. Each cluster card hosts its own inner
          SortableContext for its members. */}
      <SortableContext items={outerSortIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-4">
          {queueItems.map((item) => {
            if (item.type === 'cluster') {
              const cluster = item.data;
              return (
                <SortableClusterCard
                  key={cluster.id}
                  cluster={cluster}
                  positionByTicket={positionByTicket}
                  onUnpin={onUnpin}
                  pinnedTicketIds={pinnedTicketIds}
                  currentlyActiveId={currentlyActiveId}
                  onTicketClick={(ticketId) => setDetailTicketId(ticketId)}
                />
              );
            }
            // Individual (non-clustered) ticket — flat sortable item at the
            // top level, draggable above/below clusters.
            const ticket = item.data;
            return (
              <div key={ticket.id} className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                <SortableClusterTicket
                  ticket={ticket}
                  position={positionByTicket.get(ticket.id) ?? 0}
                  isPinned={!!ticket.pinnedToTicketId}
                  isCurrentlyActive={currentlyActiveId === ticket.id}
                  onUnpin={ticket.pinnedToTicketId ? () => onUnpin(ticket.id) : undefined}
                  onClick={() => setDetailTicketId(ticket.id)}
                />
              </div>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>

    {detailTicket && detailClusterContext && (
      <TicketDetailModal
        ticket={detailTicket}
        position={positionByTicket.get(detailTicket.id) ?? 0}
        isCurrentlyActive={currentlyActiveId === detailTicket.id}
        isPinned={pinnedTicketIds.has(detailTicket.id)}
        clusterLabel={detailClusterContext.memberIds.length > 1 ? detailClusterContext.label : undefined}
        clusterMemberCount={detailClusterContext.memberIds.length}
        onClose={() => setDetailTicketId(null)}
        onMakeActive={() => onMakeActive(detailTicket.id)}
        onUnpin={pinnedTicketIds.has(detailTicket.id) ? () => onUnpin(detailTicket.id) : undefined}
        onResolveOne={(explanation) => onResolveTickets([detailTicket.id], explanation)}
        onResolveCluster={(explanation) => onResolveTickets(detailClusterContext.memberIds, explanation)}
      />
    )}
    </>
  );
};

// Cluster card that's itself draggable as a whole
interface SortableClusterCardProps {
  cluster: any;
  positionByTicket: Map<string, number>;
  pinnedTicketIds: Set<string>;
  currentlyActiveId: string | null;
  onUnpin: (ticketId: string) => Promise<void>;
  onTicketClick: (ticketId: string) => void;
}

const SortableClusterCard: React.FC<SortableClusterCardProps> = ({ cluster, positionByTicket, pinnedTicketIds, currentlyActiveId, onUnpin, onTicketClick }) => {
  const sortableId = `cluster-header-${cluster.representativeTicketId}`;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, data: { type: 'cluster-header', clusterId: cluster.id } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
    opacity: isDragging ? 0.6 : 1,
  };

  // Inner SortableContext just for this cluster's members. Each cluster has
  // its own — that way member ticket ids don't collide with the outer
  // top-level sortable (which holds cluster-header ids and individual ticket ids).
  const memberIds = cluster.members.map((m: Ticket) => m.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`border border-gray-200 rounded-xl overflow-hidden bg-white ${isDragging ? 'shadow-2xl ring-2 ring-primary' : ''}`}
    >
      <div className="bg-primary-light/50 px-5 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing p-1 hover:bg-white/60 rounded text-primary/60 hover:text-primary transition-colors shrink-0"
            aria-label="Drag entire cluster"
            title="Drag to reorder cluster in queue"
          >
            <GripVertical className="w-4 h-4" />
          </div>
          <span className="px-2.5 py-1 bg-primary text-white text-xs font-bold rounded uppercase shrink-0">
            Cluster
          </span>
          <span className="text-sm font-bold text-dark truncate">{cluster.label}</span>
        </div>
        <span className="text-xs text-gray-medium font-bold uppercase tracking-wider shrink-0">
          {cluster.members.length} similar
        </span>
      </div>
      <SortableContext items={memberIds} strategy={verticalListSortingStrategy}>
        <div>
          {cluster.members.map((ticket: Ticket) => (
            <SortableClusterTicket
              key={ticket.id}
              ticket={ticket}
              position={positionByTicket.get(ticket.id) ?? 0}
              isPinned={pinnedTicketIds.has(ticket.id)}
              isCurrentlyActive={currentlyActiveId === ticket.id}
              onUnpin={pinnedTicketIds.has(ticket.id) ? () => onUnpin(ticket.id) : undefined}
              onClick={() => onTicketClick(ticket.id)}
            />
          ))}
          <DroppableClusterZone clusterKey={`cluster-${cluster.representativeTicketId}`} label={cluster.label} />
        </div>
      </SortableContext>
    </div>
  );
};

const SortableTicketItem: React.FC<{ ticket: Ticket, index: number, session: Session }> = ({ ticket, index, session }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: ticket.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div 
      ref={setNodeRef}
      style={style}
      className={`bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex items-center justify-between ${isDragging ? 'shadow-lg ring-2 ring-primary/20' : ''}`}
    >
      <div className="flex items-center gap-4">
        <div 
          {...attributes} 
          {...listeners} 
          className="cursor-grab active:cursor-grabbing p-1 hover:bg-gray-100 rounded text-gray-300 hover:text-gray-500 transition-colors"
        >
          <GripVertical className="w-5 h-5" />
        </div>
        <span className="text-sm font-bold text-gray-medium w-6">#{index + 2}</span>
        <div>
          <div className="flex items-center gap-2">
            <h4 className="font-bold text-dark">Student {String.fromCharCode(66 + index)}</h4>
            {ticket.attendanceMode && (
              <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                {ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <span className="text-[10px] font-bold text-primary uppercase">{ticket.topic}</span>
            <span className="text-[10px] font-bold text-gray-medium uppercase">{ticket.assignment}</span>
          </div>
        </div>
      </div>
      <span className="text-[10px] font-bold text-gray-medium uppercase">+{(index + 1) * session.avgMin} min</span>
    </div>
  );
};

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentScreen, setCurrentScreen] = useState<Screen>('LOGIN');
  const currentScreenRef = useRef<Screen>(currentScreen);
  // Keep ref in sync with state for use in non-reactive callbacks
  useEffect(() => { currentScreenRef.current = currentScreen; }, [currentScreen]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'Upcoming' | 'My Tickets' | 'Archive'>('Upcoming');
  const [isEditGuardrailOpen, setIsEditGuardrailOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDemoExplanation, setIsDemoExplanation] = useState(false);
  const [taResponse, setTaResponse] = useState('');
  const [taResolveClusterTarget, setTaResolveClusterTarget] = useState<{ memberIds: string[]; label: string } | null>(null);
  const [isSeeding, setIsSeeding] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);
  const [viewingTicketId, setViewingTicketId] = useState<string | null>(null);

  // User profile & school state
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [schoolName, setSchoolName] = useState('');

  // Registration form state
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regRole, setRegRole] = useState<'student' | 'ta'>('student');
  const [regSchoolMode, setRegSchoolMode] = useState<'join' | 'create'>('join');
  const [regSchoolId, setRegSchoolId] = useState('');
  const [regSchoolName, setRegSchoolName] = useState('');
  const [regError, setRegError] = useState('');
  const [isRegLoading, setIsRegLoading] = useState(false);

  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [isEndSessionConfirmOpen, setIsEndSessionConfirmOpen] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // R5: Hybrid queue attendance mode
  const [attendanceMode, setAttendanceMode] = useState<'in-person' | 'online'>('in-person');

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // TA State
  const [taActiveTab, setTaActiveTab] = useState<'My Sessions' | 'Archive' | 'Analytics'>('My Sessions');
  const [isAddSessionModalOpen, setIsAddSessionModalOpen] = useState(false);
  const [newSessionForm, setNewSessionForm] = useState({
    course: '',
    title: '',
    time: '',
    location: '',
    host: '',
    avgMin: 5,
    tags: '',
    assignments: ''
  });
  const [sessionFormErrors, setSessionFormErrors] = useState<Record<string, string>>({});

  // R3: TA clustering view mode
  const [taQueueViewMode, setTaQueueViewMode] = useState<'list' | 'grouped'>('list');

  // Form State
  const [topic, setTopic] = useState('');
  const [assignment, setAssignment] = useState('');
  const [summary, setSummary] = useState('');
  const [helpType, setHelpType] = useState('');

  // Session Loading Timeout Fallback
  useEffect(() => {
    if (loading && user && isAuthReady) {
      const t = setTimeout(() => {
        console.warn('Session loading timed out, forcing loading to false');
        setLoading(false);
      }, 10000);
      return () => clearTimeout(t);
    }
  }, [loading, user, isAuthReady]);

  // Auth Listener
  useEffect(() => {
    console.log('Auth listener initialized');
    
    // Fallback: if Firebase takes too long to respond, force ready state
    const timeout = setTimeout(() => {
      if (!isAuthReady) {
        console.warn('Auth initialization timed out, forcing ready state');
        setIsAuthReady(true);
      }
    }, 5000);

    let signOutDebounce: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      console.log('Auth state changed:', { hasUser: !!user, email: user?.email });
      clearTimeout(timeout);
      
      if (user) {
        // User signed in — cancel any pending sign-out debounce
        if (signOutDebounce) {
          clearTimeout(signOutDebounce);
          signOutDebounce = null;
        }
        setUser(user);
        
        // Fetch the user's profile from Firestore
        try {
          const profile = await getUserProfile(user.uid);
          if (profile) {
            setUserProfile(profile);
            // Fetch school name for display
            const school = await getSchool(profile.schoolId);
            if (school) setSchoolName(school.name);
            
            setIsAuthReady(true);
            if (currentScreenRef.current === 'LOGIN' || currentScreenRef.current === 'REGISTER') {
              if (profile.role === 'ta') {
                setCurrentScreen('TA_DASHBOARD');
              } else {
                setCurrentScreen('S1');
              }
            }
          } else {
            // Auth account exists but no Firestore profile (legacy user or incomplete registration)
            // Send them to register to complete their profile
            console.warn('User has auth account but no Firestore profile — redirecting to register');
            setIsAuthReady(true);
            setCurrentScreen('REGISTER');
          }
        } catch (err) {
          console.error('Error fetching user profile:', err);
          setIsAuthReady(true);
          setCurrentScreen('REGISTER');
        }
      } else {
        // Debounce sign-out to avoid wiping data on transient token refreshes
        signOutDebounce = setTimeout(() => {
          console.log('Auth confirmed signed out — clearing session data');
          setUser(null);
          setUserProfile(null);
          setSchoolName('');
          setIsAuthReady(true);
          setSessions([]);
          setCurrentScreen('LOGIN');
        }, 5000);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timeout);
      if (signOutDebounce) clearTimeout(signOutDebounce);
    };
  }, []);

  // Fetch Sessions and Tickets
  useEffect(() => {
    if (!isAuthReady || !user || !userProfile) {
      console.log('Session fetch skipped:', { isAuthReady, hasUser: !!user, hasProfile: !!userProfile });
      return;
    }

    console.log('Starting session fetch for school:', userProfile.schoolId);
    const sessionsRef = collection(db, 'sessions');
    const q = query(sessionsRef, where('schoolId', '==', userProfile.schoolId), orderBy('course'));
    let isFirstSnapshot = true;

    const unsubscribeSessions = onSnapshot(q, (snapshot) => {
      console.log('Sessions snapshot received:', { count: snapshot.docs.length, fromCache: snapshot.metadata.fromCache });
      const sessionsData: Session[] = [];
      
      snapshot.docs.forEach((sessionDoc) => {
        const session = { id: sessionDoc.id, ...sessionDoc.data() } as Session;
        sessionsData.push(session);
      });

      setSessions(prev => {
        // Guard against transient empty snapshots wiping existing data
        // Only allow empty if this is the first snapshot (genuinely no sessions) or data was intentionally cleared
        if (sessionsData.length === 0 && prev.length > 0 && !isFirstSnapshot) {
          console.warn('Ignoring empty snapshot — likely a transient Firestore sync issue. Previous session count:', prev.length);
          return prev;
        }
        isFirstSnapshot = false;
        
        return sessionsData.map(newSession => {
          const existing = prev.find(s => s.id === newSession.id);
          if (existing) {
            return {
              ...newSession,
              tickets: existing.tickets || [],
              queueCount: existing.queueCount || 0,
              estWait: existing.estWait || 0,
              estimatedWait: existing.estimatedWait || 0
            };
          }
          return { ...newSession, tickets: [] };
        });
      });
      setLoading(false);
    }, (error) => {
      console.error('Sessions fetch error:', error);
      setLoading(false);
      // Don't wipe sessions on error — keep existing data visible
      handleFirestoreError(error, OperationType.LIST, 'sessions');
    });

    return () => unsubscribeSessions();
  // Use user.uid and schoolId to avoid re-subscribing on token refresh
  }, [isAuthReady, user?.uid, userProfile?.schoolId]);

  // Stable key for session IDs to avoid unnecessary re-subscriptions
  const sessionIds = useMemo(() => sessions.map(s => s.id).sort().join(','), [sessions]);

  // Sub-collection listeners for tickets.
  //
  // Each session's ticket list first tries the Go realtime hub (one shared
  // server-side Firestore listener per session, fanned out over WebSocket)
  // instead of every connected browser opening its own onSnapshot listener.
  // If the hub is unreachable (not deployed, connection drops, etc.) this
  // falls back to the direct Firestore listener per session, same as before.
  useEffect(() => {
    if (!user || sessions.length === 0) return;

    const applyTickets = (sessionId: string, tickets: Ticket[]) => {
      const activeTickets = tickets.filter(t => t.status === 'active');
      // Count only tickets ordered before the current user's ticket
      const userIndex = activeTickets.findIndex(t => t.uid === user.uid);
      const aheadCount = userIndex === -1 ? activeTickets.length : userIndex;
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s,
        tickets,
        queueCount: aheadCount,
        estWait: aheadCount * s.avgMin,
        estimatedWait: aheadCount * s.avgMin
      } : s));
    };

    const cleanups = sessions.map(session => {
      let disposed = false;
      let stopFirestore: (() => void) | null = null;

      const subscribeFirestoreFallback = () => {
        if (disposed || stopFirestore) return;
        const ticketsRef = collection(db, 'sessions', session.id, 'tickets');
        const q = query(ticketsRef, orderBy('createdAt', 'asc'));
        stopFirestore = onSnapshot(q, (snapshot) => {
          const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Ticket));
          applyTickets(session.id, tickets);
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, `sessions/${session.id}/tickets`);
        });
      };

      const stopHub = connectTicketsHub(
        session.id,
        (tickets) => applyTickets(session.id, tickets as Ticket[]),
        () => {
          console.warn(`Realtime hub unavailable for session ${session.id}; falling back to direct Firestore listener.`);
          subscribeFirestoreFallback();
        }
      );

      return () => {
        disposed = true;
        stopHub();
        stopFirestore?.();
      };
    });

    return () => cleanups.forEach(cleanup => cleanup());
  }, [sessionIds, user]);

  const myTicket = useMemo(() => {
    if (!user) return null;
    for (const session of sessions) {
      const ticket = session.tickets.find(t => t.uid === user.uid && t.status === 'active');
      if (ticket) return { ...ticket, sessionId: session.id };
    }
    return null;
  }, [sessions, user]);

  const archivedTickets = useMemo(() => {
    if (!user) return [];
    const archived: any[] = [];
    sessions.forEach(session => {
      session.tickets.forEach(ticket => {
        if (ticket.uid === user.uid && (ticket.status === 'resolved' || ticket.status === 'archived' || session.status === 'archived')) {
          archived.push({ ...ticket, session });
        }
      });
    });
    return archived.sort((a, b) => {
      const timeA = a.resolvedAt?.toDate?.()?.getTime() || a.createdAt?.toDate?.()?.getTime() || 0;
      const timeB = b.resolvedAt?.toDate?.()?.getTime() || b.createdAt?.toDate?.()?.getTime() || 0;
      return timeB - timeA;
    });
  }, [sessions, user]);

  const archivedSessions = useMemo(() => {
    return sessions.filter(s => s.status === 'archived').sort((a, b) => {
      // Assuming time string might contain date, but let's try to sort by something more reliable if available
      // For now just course name or reverse order of discovery
      return a.course.localeCompare(b.course);
    });
  }, [sessions]);

  // Analytics computations
  const analyticsData = useMemo(() => {
    const allTickets: (Ticket & { sessionCourse: string })[] = [];
    sessions.forEach(s => {
      s.tickets.forEach(t => allTickets.push({ ...t, sessionCourse: s.course }));
    });
    const resolved = allTickets.filter(t => t.status === 'resolved');
    const active = allTickets.filter(t => t.status === 'active');
    const byTopic: Record<string, number> = {};
    allTickets.forEach(t => { byTopic[t.topic] = (byTopic[t.topic] || 0) + 1; });
    const byHelpType: Record<string, number> = {};
    allTickets.forEach(t => { byHelpType[t.helpType] = (byHelpType[t.helpType] || 0) + 1; });
    const byCourse: Record<string, number> = {};
    allTickets.forEach(t => { byCourse[t.sessionCourse] = (byCourse[t.sessionCourse] || 0) + 1; });
    const byMode: Record<string, number> = { 'in-person': 0, 'online': 0, 'unknown': 0 };
    allTickets.forEach(t => { byMode[t.attendanceMode || 'unknown'] = (byMode[t.attendanceMode || 'unknown'] || 0) + 1; });
    let totalResolutionMs = 0, resolutionCount = 0;
    resolved.forEach(t => {
      const c = t.createdAt?.toDate?.()?.getTime();
      const r = t.resolvedAt?.toDate?.()?.getTime();
      if (c && r) { totalResolutionMs += (r - c); resolutionCount++; }
    });
    const avgResolutionMin = resolutionCount > 0 ? Math.round(totalResolutionMs / resolutionCount / 60000) : 0;
    return {
      totalTickets: allTickets.length, resolvedCount: resolved.length, activeCount: active.length,
      byTopic, byHelpType, byCourse, byMode, avgResolutionMin,
      liveSessions: sessions.filter(s => s.status === 'live').length,
      archivedSessions: sessions.filter(s => s.status === 'archived').length,
      upcomingSessions: sessions.filter(s => s.status === 'upcoming').length,
    };
  }, [sessions]);

  // Embed-and-cluster the active tickets for the currently selected session.
  // Lazy-loads MiniLM on first invocation, caches per-ticket embeddings so
  // only new/changed tickets get re-embedded on subsequent updates.
  const activeTicketsForClustering = useMemo(() => {
    const session = sessions.find(s => s.id === selectedSessionId);
    return (session?.tickets?.filter(t => t.status === 'active') || [])
      .map(t => ({
        id: t.id,
        topic: t.topic,
        assignment: t.assignment,
        summary: t.summary,
        pinnedToTicketId: (t as any).pinnedToTicketId ?? null,
      }));
  }, [sessions, selectedSessionId]);

  const { clusters: clusterResult, loading: clustersLoading } = useTicketClusters(activeTicketsForClustering);

  // Update a ticket's manual cluster pin. Pass null to remove the pin and
  // let the embedding-based clustering decide. Pass NOISE_PIN to force the
  // ticket into the "Other" bucket. Pass another ticket's id to pin the
  // dragged ticket into that ticket's cluster.
  const updateTicketPin = async (
    sessionId: string,
    ticketId: string,
    pinnedToTicketId: string | null,
    newCreatedAtMs?: number
  ) => {
    try {
      const update: any = { pinnedToTicketId };
      if (newCreatedAtMs !== undefined) {
        update.createdAt = Timestamp.fromMillis(newCreatedAtMs);
      }
      await updateDoc(doc(db, 'sessions', sessionId, 'tickets', ticketId), update);
    } catch (error) {
      console.error('Error updating ticket pin:', error);
      handleFirestoreError(error, OperationType.UPDATE, `sessions/${sessionId}/tickets/${ticketId}`);
    }
  };

  const DEMO_SCHOOL_ID = 'sq-demo';


  const handleSeedUsers = async () => {
    setIsSeeding(true);
    setSeedMessage(null);
    try {
      // 1. Register the TA account first — this signs us in, which is needed
      //    for Firestore writes (rules require isSignedIn())
      let taUid: string | null = null;
      try {
        const taCred = await registerWithEmail('admin@university.edu', 'admin1234');
        taUid = taCred.user.uid;
        console.log('Created TA auth account');
      } catch (err: any) {
        if (err.code === 'auth/email-already-in-use') {
          console.log('TA account already exists — logging in to proceed');
          const taCred = await loginWithEmail('admin@university.edu', 'admin1234');
          taUid = taCred.user.uid;
        } else {
          throw err;
        }
      }

      // 2. Now we're signed in as the TA — create the demo school if needed
      const existingSchool = await getSchool(DEMO_SCHOOL_ID);
      if (!existingSchool) {
        await createSchool(DEMO_SCHOOL_ID, { name: 'Demo University', createdBy: taUid! });
        console.log('Created demo school: sq-demo');
      }

      // 3. Create TA profile if it doesn't exist
      const existingTAProfile = await getUserProfile(taUid!);
      if (!existingTAProfile) {
        await createUserProfile(taUid!, {
          email: 'admin@university.edu',
          displayName: 'Demo TA',
          role: 'ta',
          schoolId: DEMO_SCHOOL_ID,
        });
        console.log('Created TA profile');
      }

      // 4. Create student accounts + profiles
      const students = [
        { email: 'student1@university.edu', pass: 'root1234', displayName: 'Student One' },
        { email: 'student2@university.edu', pass: 'root1234', displayName: 'Student Two' },
        { email: 'student3@university.edu', pass: 'root1234', displayName: 'Student Three' },
        { email: 'student4@university.edu', pass: 'root1234', displayName: 'Student Four' },
      ];

      for (const s of students) {
        try {
          const cred = await registerWithEmail(s.email, s.pass);
          // Now signed in as this student — create their profile
          await createUserProfile(cred.user.uid, {
            email: s.email,
            displayName: s.displayName,
            role: 'student',
            schoolId: DEMO_SCHOOL_ID,
          });
          console.log(`Created user + profile: ${s.email}`);
        } catch (err: any) {
          if (err.code === 'auth/email-already-in-use') {
            console.log(`User already exists: ${s.email}`);
          } else {
            throw err;
          }
        }
      }

      // 5. Sign out so the user can choose which account to log in as
      await logout();
      setSeedMessage('Demo users created! Log in as student1@university.edu / root1234 or admin@university.edu / admin1234');
    } catch (error: any) {
      console.error('Error seeding users:', error);
      setAuthError('Error seeding users: ' + error.message);
    } finally {
      setIsSeeding(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);
    try {
      // If user just typed "student1", append domain
      let loginEmail = email;
      if (!email.includes('@')) {
        loginEmail = `${email}@university.edu`;
      }
      const userCredential = await loginWithEmail(loginEmail, password);
      // Routing is handled by the onAuthStateChanged listener which fetches the profile
    } catch (error: any) {
      console.error('Login error:', error);
      setAuthError('Invalid username or password. If you haven\'t seeded users yet, click the "Seed Users" button below.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const isTA = userProfile?.role === 'ta';

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');
    setIsRegLoading(true);
    try {
      // Validate school selection. For "join existing school", the actual
      // existence check has to wait until after auth — schools/{schoolId}
      // reads require isSignedIn(), so checking pre-auth always fails with
      // "Missing or insufficient permissions" regardless of whether the
      // school exists.
      let schoolId: string;
      if (regRole === 'ta' && regSchoolMode === 'create') {
        // TA creating a new school
        if (!regSchoolName.trim()) {
          setRegError('Please enter a school/organization name.');
          setIsRegLoading(false);
          return;
        }
        schoolId = generateSchoolId();
        // We'll create the school doc after auth registration
      } else {
        // Joining an existing school
        if (!regSchoolId.trim()) {
          setRegError('Please enter a School ID to join.');
          setIsRegLoading(false);
          return;
        }
        schoolId = regSchoolId.trim().toLowerCase();
      }

      // Create Firebase Auth account
      const cred = await registerWithEmail(regEmail, regPassword);

      // Create school doc if TA is creating one; otherwise now that we're
      // signed in, confirm the school being joined actually exists — roll
      // back the auth account if not, so a bad school ID doesn't leave a
      // dangling account with no profile.
      if (regRole === 'ta' && regSchoolMode === 'create') {
        await createSchool(schoolId, { name: regSchoolName.trim(), createdBy: cred.user.uid });
      } else {
        const existingSchool = await getSchool(schoolId);
        if (!existingSchool) {
          await cred.user.delete();
          setRegError(`No school found with ID "${schoolId}". Check the code and try again.`);
          setIsRegLoading(false);
          return;
        }
      }

      // Create user profile in Firestore
      const profile = await createUserProfile(cred.user.uid, {
        email: regEmail,
        displayName: regDisplayName.trim() || regEmail.split('@')[0],
        role: regRole,
        schoolId,
      });

      setUserProfile(profile);
      const school = await getSchool(schoolId);
      if (school) setSchoolName(school.name);

      // Route to the right dashboard
      if (profile.role === 'ta') {
        setCurrentScreen('TA_DASHBOARD');
      } else {
        setCurrentScreen('S1');
      }
    } catch (error: any) {
      console.error('Registration error:', error);
      if (error.code === 'auth/email-already-in-use') {
        setRegError('An account with this email already exists. Try logging in instead.');
      } else if (error.code === 'auth/weak-password') {
        setRegError('Password must be at least 6 characters.');
      } else {
        setRegError(error.message || 'Registration failed. Please try again.');
      }
    } finally {
      setIsRegLoading(false);
    }
  };

  // Helper to copy school ID to clipboard
  const copySchoolId = async () => {
    if (userProfile?.schoolId) {
      await navigator.clipboard.writeText(userProfile.schoolId);
    }
  };

  const handleMarkUpNext = async (sessionId: string, ticketId: string) => {
    try {
      // To mark as "up next", we set its createdAt to a very old date
      // so it appears first in the 'asc' order.
      await updateDoc(doc(db, 'sessions', sessionId, 'tickets', ticketId), {
        createdAt: Timestamp.fromMillis(0)
      });
      console.log('Ticket marked as up next');
    } catch (error) {
      console.error('Error marking ticket as up next:', error);
      handleFirestoreError(error, OperationType.UPDATE, `sessions/${sessionId}/tickets/${ticketId}`);
    }
  };

  const validateSessionForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!newSessionForm.course.trim()) errors.course = 'Course code is required';
    if (!newSessionForm.title.trim()) errors.title = 'Session title is required';
    if (!newSessionForm.time.trim()) {
      errors.time = 'Date/time is required';
    } else {
      const timeStr = newSessionForm.time.trim().toLowerCase();
      if (!timeStr.startsWith('today') && !timeStr.startsWith('tomorrow')) {
        const parsed = new Date(newSessionForm.time);
        if (!isNaN(parsed.getTime()) && parsed < new Date(new Date().toDateString())) {
          errors.time = 'Session date cannot be in the past';
        }
      }
    }
    if (!newSessionForm.location.trim()) errors.location = 'Location is required';
    if (!newSessionForm.host.trim()) errors.host = 'Host name is required';
    if (!newSessionForm.avgMin || newSessionForm.avgMin < 1 || newSessionForm.avgMin > 60) errors.avgMin = 'Must be between 1 and 60';
    setSessionFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAddSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isTA) return;
    if (!validateSessionForm()) return;
    
    try {
      const tagsArray = newSessionForm.tags.split(',').map(t => t.trim()).filter(t => t !== '');
      const assignmentsArray = newSessionForm.assignments ? newSessionForm.assignments.split(',').map(a => a.trim()).filter(a => a !== '') : [];
      await addDoc(collection(db, 'sessions'), {
        course: newSessionForm.course, title: newSessionForm.title, time: newSessionForm.time,
        location: newSessionForm.location, host: newSessionForm.host, avgMin: newSessionForm.avgMin,
        tags: tagsArray, assignments: assignmentsArray,
        schoolId: userProfile!.schoolId,
        status: 'upcoming', createdAt: serverTimestamp()
      });
      setIsAddSessionModalOpen(false);
      setNewSessionForm({ course: '', title: '', time: '', location: '', host: '', avgMin: 5, tags: '', assignments: '' });
      setSessionFormErrors({});
    } catch (error) {
      console.error('Error adding session:', error);
    }
  };

  const handleStartSession = async (sessionId: string) => {
    try {
      await updateDoc(doc(db, 'sessions', sessionId), { status: 'live' });
      setCurrentScreen('TA_SESSION_LIVE');
    } catch (error) {
      console.error('Error starting session:', error);
    }
  };

  const handleEndSession = async (sessionId: string) => {
    try {
      // Archive all remaining active tickets so they don't stay 'active' in Firestore
      const sessionData = sessions.find(s => s.id === sessionId);
      if (sessionData) {
        const activeTickets = sessionData.tickets.filter(t => t.status === 'active');
        for (const ticket of activeTickets) {
          await updateDoc(doc(db, 'sessions', sessionId, 'tickets', ticket.id), {
            status: 'archived',
            resolvedAt: serverTimestamp()
          });
        }
      }
      await updateDoc(doc(db, 'sessions', sessionId), { status: 'archived' });
      setIsEndSessionConfirmOpen(false);
      setCurrentScreen('TA_DASHBOARD');
    } catch (error) {
      console.error('Error ending session:', error);
    }
  };

  const handleResolveTicket = async (sessionId: string, ticketId: string, explanation: string) => {
    try {
      await updateDoc(doc(db, 'sessions', sessionId, 'tickets', ticketId), {
        status: 'resolved',
        taExplanation: explanation,
        resolvedAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error resolving ticket:', error);
    }
  };

  const handleSeedData = async () => {
    console.log('handleSeedData triggered', { userEmail: user?.email });
    if (!user || !isTA) {
      console.log('Not a TA, returning');
      return;
    }
    
    setIsSeeding(true);
    setResetStatus(null);
    try {
      console.log('Starting data reset...');
      // 1. Get sessions belonging to this school only
      const sessionsSnap = await getDocs(
        query(collection(db, 'sessions'), where('schoolId', '==', userProfile!.schoolId))
      );
      console.log(`Found ${sessionsSnap.docs.length} sessions to delete in school ${userProfile!.schoolId}`);
      
      // 2. For each session, delete its tickets then delete the session
      for (const sessionDoc of sessionsSnap.docs) {
        const ticketsSnap = await getDocs(collection(db, 'sessions', sessionDoc.id, 'tickets'));
        console.log(`Deleting ${ticketsSnap.docs.length} tickets for session ${sessionDoc.id}`);
        for (const ticketDoc of ticketsSnap.docs) {
          await deleteDoc(doc(db, 'sessions', sessionDoc.id, 'tickets', ticketDoc.id));
        }
        await deleteDoc(doc(db, 'sessions', sessionDoc.id));
      }

      console.log('Seeding initial sessions...');
      const initialSessions = [
        {
          course: 'CSC369',
          title: 'Operating Systems',
          time: 'Today, 2:00 PM',
          location: 'BA3185',
          host: 'TA: Sarah J.',
          avgMin: 5,
          tags: ['Homework 3', 'Exam Review', 'Project Clarification', 'Grade Inquiry', 'Concept Review'],
          assignments: ['Assignment 1', 'Assignment 2', 'Assignment 3', 'Assignment 4', 'Midterm', 'Final Exam'],
          schoolId: userProfile!.schoolId,
          status: 'upcoming'
        },
        {
          course: 'STA355',
          title: 'Theory of Statistics',
          time: 'Tomorrow, 10:00 AM',
          location: 'SS1071',
          host: 'Prof. Smith',
          avgMin: 10,
          tags: ['Maximum Likelihood', 'Hypothesis Testing', 'Confidence Intervals'],
          assignments: ['Problem Set 1', 'Problem Set 2', 'Problem Set 3', 'Problem Set 4', 'Midterm', 'Final Exam'],
          schoolId: userProfile!.schoolId,
          status: 'upcoming'
        },
        {
          course: 'MAT237',
          title: 'Multivariable Calculus',
          time: 'Wed Mar 18, 1:00 PM',
          location: 'PG101',
          host: 'TA: Mike T.',
          avgMin: 8,
          tags: ['Stokes Theorem', 'Line Integrals', 'Surface Integrals'],
          assignments: ['Problem Set 1', 'Problem Set 2', 'Problem Set 3', 'Term Test 1', 'Term Test 2', 'Final Exam'],
          schoolId: userProfile!.schoolId,
          status: 'upcoming'
        }
      ];

      for (const s of initialSessions) {
        await addDoc(collection(db, 'sessions'), { ...s, createdAt: serverTimestamp() });
      }
      console.log('Data reset and seed complete');
      setResetStatus({ type: 'success', message: 'System reset and seeded successfully!' });
      setTimeout(() => setResetStatus(null), 5000);
    } catch (error) {
      console.error('Error seeding data:', error);
      setResetStatus({ type: 'error', message: 'Error resetting data. Check console.' });
    } finally {
      setIsSeeding(false);
      setIsResetConfirmOpen(false);
    }
  };

  const handleSubmitTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    console.log('handleSubmitTicket triggered', { 
      hasUser: !!user, 
      selectedSessionId, 
      isUpdate: !!(myTicket && myTicket.sessionId === selectedSessionId) 
    });

    if (!user) {
      console.error('Submit failed: No user authenticated');
      setSubmitError('You must be logged in to submit a ticket.');
      return;
    }
    if (!selectedSessionId) {
      console.error('Submit failed: No session selected');
      setSubmitError('Please select a session before submitting.');
      return;
    }

    try {
      if (myTicket && myTicket.sessionId === selectedSessionId) {
        // Update existing
        const updateData = {
          topic,
          assignment,
          summary,
          helpType,
          attendanceMode,
          status: 'active'
        };
        await updateDoc(doc(db, 'sessions', selectedSessionId, 'tickets', myTicket.id), updateData);
      } else {
        // If user already has a ticket in a different session, archive it first
        if (myTicket && myTicket.sessionId !== selectedSessionId) {
          await updateDoc(doc(db, 'sessions', myTicket.sessionId, 'tickets', myTicket.id), {
            status: 'archived',
            resolvedAt: serverTimestamp()
          });
        }
        // Create new
        const ticketData = {
          topic,
          assignment,
          summary,
          helpType,
          attendanceMode,
          uid: user.uid,
          createdAt: serverTimestamp(),
          status: 'active'
        };
        await addDoc(collection(db, 'sessions', selectedSessionId, 'tickets'), ticketData);
      }
      setCurrentScreen('S5');
    } catch (error) {
      console.error('Firestore write error:', error);
      setSubmitError('Failed to submit ticket. Please try again.');
      handleFirestoreError(error, OperationType.WRITE, `sessions/${selectedSessionId}/tickets`);
    }
  };

  const handleEditTicket = () => {
    setSubmitError(null);
    if (myTicket) {
      setTopic(myTicket.topic);
      setAssignment(myTicket.assignment);
      setSummary(myTicket.summary);
      setHelpType(myTicket.helpType);
      setAttendanceMode(myTicket.attendanceMode || 'in-person');
      setIsEditGuardrailOpen(true);
    }
  };

  const confirmEdit = () => {
    setIsEditGuardrailOpen(false);
    setCurrentScreen('S3');
  };

  const handleDeleteTicket = () => {
    setIsDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!user || !myTicket) return;
    try {
      // Archive instead of delete to preserve data for analytics and student review
      await updateDoc(doc(db, 'sessions', myTicket.sessionId, 'tickets', myTicket.id), {
        status: 'archived',
        resolvedAt: serverTimestamp()
      });
      setIsDeleteConfirmOpen(false);
      setCurrentScreen('S1');
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `sessions/${myTicket.sessionId}/tickets/${myTicket.id}`);
    }
  };

  // Helper: get assignment options for a session
  const getAssignmentOptions = (session: Session): string[] => {
    if (session.assignments && session.assignments.length > 0) return session.assignments;
    if (COURSE_ASSIGNMENTS[session.course]) return COURSE_ASSIGNMENTS[session.course];
    return DEFAULT_ASSIGNMENTS;
  };

  // Helper component for analytics bar chart
  const BarChart: React.FC<{ data: Record<string, number>, color?: string }> = ({ data, color = 'bg-primary' }) => {
    const maxVal = Math.max(...Object.values(data), 1);
    return (
      <div className="space-y-2">
        {Object.entries(data).map(([label, value]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="text-sm text-dark font-medium w-28 truncate">{label}</span>
            <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden">
              <div className={`${color} h-full rounded-full flex items-center justify-end pr-2 transition-all duration-500`} style={{ width: `${Math.max((value / maxVal) * 100, 8)}%` }}>
                <span className="text-white text-xs font-bold">{value}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const TopNav = () => (
    <header className="bg-primary text-white sticky top-0 z-50 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-white rounded flex items-center justify-center text-primary font-bold text-xl" aria-hidden="true">
            SQ
          </div>
          <h1 className="text-xl font-bold tracking-tight">SmartQueue</h1>
          {schoolName && (
            <span className="hidden sm:inline text-sm text-white/70 ml-2">· {schoolName}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {user ? (
            <>
              {isTA && userProfile?.schoolId && (
                <button
                  onClick={copySchoolId}
                  className="hidden sm:flex items-center gap-1.5 text-white/70 hover:text-white text-xs font-mono bg-white/10 px-2.5 py-1.5 rounded-lg transition-colors"
                  title="Click to copy School ID"
                >
                  <Hash className="w-3 h-3" />
                  {userProfile.schoolId}
                  <Copy className="w-3 h-3" />
                </button>
              )}
              <button 
                onClick={logout}
                className="text-white/80 hover:text-white flex items-center gap-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded px-2 py-1 transition-colors hover:bg-white/10 active:scale-95"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Log Out</span>
              </button>
              <div className="flex items-center gap-3">
                <span className="hidden md:inline text-sm font-medium text-white/90">{userProfile?.displayName || user.displayName || user.email}</span>
                <img 
                  src={user.photoURL || `https://ui-avatars.com/api/?name=${userProfile?.displayName || user.displayName || 'User'}&background=random`} 
                  alt=""
                  className="w-10 h-10 rounded-full border-2 border-white/20 shadow-sm"
                  referrerPolicy="no-referrer"
                />
              </div>
            </>
          ) : (
            <button 
              onClick={() => setCurrentScreen('LOGIN')}
              className="bg-white text-primary px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-primary-light transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Log In
            </button>
          )}
        </div>
      </div>
    </header>
  );

  const renderScreen = () => {
    if (!isAuthReady) {
      return (
        <main className="min-h-[calc(100vh-64px)] flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-primary rounded-xl flex items-center justify-center text-white font-bold text-3xl shadow-sm mb-2">SQ</div>
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-gray-medium animate-pulse font-medium">Initializing SmartQueue...</p>
          </div>
        </main>
      );
    }

    if (user && sessions.length === 0 && loading) {
      return (
        <main className="min-h-[calc(100vh-64px)] flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-gray-medium font-medium">Loading your sessions...</p>
          </div>
        </main>
      );
    }

    const session = sessions.find(s => s.id === selectedSessionId) || 
                    (myTicket ? sessions.find(s => s.id === myTicket.sessionId) : null) || 
                    sessions[0] || 
                    { id: '', course: '', title: '', time: '', location: '', host: '', avgMin: 0, tags: [], tickets: [], queueCount: 0, estWait: 0, estimatedWait: 0, status: 'upcoming' as const };

    const isSessionArchived = session.status === 'archived';

    switch (currentScreen) {
      case 'LOGIN':
        return (
          <main className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4 py-12 bg-gray-50">
            <div className="max-w-md w-full bg-white rounded-xl shadow-lg border border-gray-200 p-8">
              <div className="flex justify-center mb-6">
                <div className="w-16 h-16 bg-primary rounded-xl flex items-center justify-center text-white font-bold text-3xl shadow-sm">SQ</div>
              </div>
              <h2 className="text-2xl font-bold text-dark text-center mb-2">Welcome to SmartQueue</h2>
              <p className="text-gray-medium text-center mb-8">Sign in with your university credentials.</p>
              
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-dark mb-1" htmlFor="username">Username / Email</label>
                  <input 
                    id="username"
                    type="text"
                    placeholder="e.g. student1"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-dark mb-1" htmlFor="password">Password</label>
                  <input 
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>

                {authError && (
                  <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}

                {seedMessage && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-emerald-700 text-sm flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{seedMessage}</span>
                  </div>
                )}

                <button 
                  type="submit"
                  disabled={isAuthLoading}
                  className="w-full py-4 bg-primary text-white font-bold rounded-lg shadow-md hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  {isAuthLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
                  Sign In
                </button>
              </form>

              <div className="mt-8 pt-6 border-t border-gray-100">
                <p className="text-sm text-gray-medium text-center mb-4">Don't have an account?</p>
                <button 
                  onClick={() => { setRegError(''); setCurrentScreen('REGISTER'); }}
                  className="w-full py-3 border-2 border-primary text-primary font-bold rounded-lg hover:bg-primary-light transition-all flex items-center justify-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  Create Account
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs text-gray-medium text-center mb-3">Just want to try it out?</p>
                <button 
                  onClick={handleSeedUsers}
                  disabled={isSeeding}
                  className="w-full py-2.5 bg-gray-100 text-gray-medium font-semibold rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 text-sm"
                >
                  {isSeeding ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Seed Demo Accounts'}
                </button>
                <p className="text-[11px] text-gray-medium/60 text-center mt-2">
                  Creates demo school <span className="font-mono">sq-demo</span> with student &amp; TA accounts
                </p>
              </div>
            </div>
          </main>
        );

      case 'REGISTER':
        return (
          <main className="min-h-[calc(100vh-64px)] flex items-center justify-center px-4 py-12 bg-gray-50">
            <div className="max-w-md w-full bg-white rounded-xl shadow-lg border border-gray-200 p-8">
              <div className="flex justify-center mb-6">
                <div className="w-16 h-16 bg-primary rounded-xl flex items-center justify-center text-white font-bold text-3xl shadow-sm">SQ</div>
              </div>
              <h2 className="text-2xl font-bold text-dark text-center mb-2">Create Your Account</h2>
              <p className="text-gray-medium text-center mb-8">Join SmartQueue as a student or TA.</p>
              
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-dark mb-1" htmlFor="reg-name">Display Name</label>
                  <input 
                    id="reg-name"
                    type="text"
                    placeholder="e.g. Andrew G."
                    value={regDisplayName}
                    onChange={(e) => setRegDisplayName(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-dark mb-1" htmlFor="reg-email">Email</label>
                  <input 
                    id="reg-email"
                    type="email"
                    placeholder="you@university.edu"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-dark mb-1" htmlFor="reg-password">Password</label>
                  <input 
                    id="reg-password"
                    type="password"
                    placeholder="Min 6 characters"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                    required
                  />
                </div>

                {/* Role Selection */}
                <div>
                  <label className="block text-sm font-bold text-dark mb-2">I am a...</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => { setRegRole('student'); setRegSchoolMode('join'); }}
                      className={`p-4 rounded-lg border-2 text-center transition-all ${regRole === 'student' ? 'border-primary bg-primary-light text-primary' : 'border-gray-200 text-gray-medium hover:border-gray-300'}`}
                    >
                      <UserIcon className="w-6 h-6 mx-auto mb-1" />
                      <span className="text-sm font-bold">Student</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setRegRole('ta')}
                      className={`p-4 rounded-lg border-2 text-center transition-all ${regRole === 'ta' ? 'border-primary bg-primary-light text-primary' : 'border-gray-200 text-gray-medium hover:border-gray-300'}`}
                    >
                      <Building2 className="w-6 h-6 mx-auto mb-1" />
                      <span className="text-sm font-bold">TA / Instructor</span>
                    </button>
                  </div>
                </div>

                {/* School Selection */}
                <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-100">
                  {regRole === 'ta' && (
                    <div className="flex gap-2 mb-3">
                      <button
                        type="button"
                        onClick={() => setRegSchoolMode('join')}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${regSchoolMode === 'join' ? 'bg-primary text-white' : 'bg-white text-gray-medium border border-gray-200'}`}
                      >
                        Join Existing
                      </button>
                      <button
                        type="button"
                        onClick={() => setRegSchoolMode('create')}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${regSchoolMode === 'create' ? 'bg-primary text-white' : 'bg-white text-gray-medium border border-gray-200'}`}
                      >
                        Create New
                      </button>
                    </div>
                  )}

                  {regSchoolMode === 'join' ? (
                    <div>
                      <label className="block text-sm font-bold text-dark mb-1">
                        <Hash className="w-3.5 h-3.5 inline mr-1" />
                        School ID
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. sq-7x3k"
                        value={regSchoolId}
                        onChange={(e) => setRegSchoolId(e.target.value)}
                        className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all font-mono"
                      />
                      <p className="text-xs text-gray-medium mt-1">Ask your TA or instructor for this code.</p>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-sm font-bold text-dark mb-1">
                        <Building2 className="w-3.5 h-3.5 inline mr-1" />
                        School / Organization Name
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. University of Toronto"
                        value={regSchoolName}
                        onChange={(e) => setRegSchoolName(e.target.value)}
                        className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                      <p className="text-xs text-gray-medium mt-1">A unique School ID will be generated for you to share with students.</p>
                    </div>
                  )}
                </div>

                {regError && (
                  <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{regError}</span>
                  </div>
                )}

                <button 
                  type="submit"
                  disabled={isRegLoading}
                  className="w-full py-4 bg-primary text-white font-bold rounded-lg shadow-md hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  {isRegLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <UserPlus className="w-5 h-5" />}
                  Create Account
                </button>
              </form>

              <div className="mt-6 text-center">
                <button 
                  onClick={() => { setAuthError(''); setCurrentScreen('LOGIN'); }}
                  className="text-sm text-primary font-semibold hover:underline"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </div>
          </main>
        );

      case 'S1':
        return (
          <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h2 className="sr-only">Student Dashboard</h2>
            
            {/* Admin Reset/Seeding (Only for TAs) */}
            {isTA && (
              <div className="mb-8 p-6 bg-primary-light rounded-xl border-2 border-dashed border-primary flex flex-col items-center text-center">
                <h3 className="text-lg font-bold text-primary mb-2">TA Controls</h3>
                <p className="text-dark mb-4">Reset the system to the base state (3 default sessions, no tickets).</p>
                
                {resetStatus && (
                  <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${resetStatus.type === 'success' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
                    {resetStatus.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                    <span className="font-medium">{resetStatus.message}</span>
                  </div>
                )}

                <button 
                  onClick={() => {
                    if (sessions.length > 0) {
                      setIsResetConfirmOpen(true);
                    } else {
                      handleSeedData();
                    }
                  }}
                  disabled={isSeeding}
                  className="px-6 py-3 bg-primary text-white font-bold rounded-lg flex items-center gap-2 hover:bg-primary-hover disabled:opacity-50 transition-all active:scale-95"
                >
                  {isSeeding ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Reset & Seed All Data'}
                </button>
              </div>
            )}

            {/* Admin Reset Confirmation Modal */}
            {isResetConfirmOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 text-center">
                  <div className="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto mb-6">
                    <AlertTriangle className="w-8 h-8" />
                  </div>
                  <h2 className="text-2xl font-bold text-dark mb-4">Reset All Data?</h2>
                  <p className="text-dark mb-8 text-lg">
                    This will permanently delete all existing sessions and all student tickets. This action cannot be undone.
                  </p>
                  <div className="flex flex-col gap-4">
                    <button 
                      onClick={handleSeedData}
                      disabled={isSeeding}
                      className="w-full px-6 py-4 bg-error text-white text-lg font-bold rounded-lg hover:bg-error/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      {isSeeding ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Yes, Reset Everything'}
                    </button>
                    <button 
                      onClick={() => setIsResetConfirmOpen(false)}
                      disabled={isSeeding}
                      className="w-full px-6 py-3 text-gray-medium font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Tabs */}
            <nav className="flex border-b border-gray-200 mb-8" aria-label="Dashboard tabs">
              <button 
                onClick={() => setActiveTab('Upcoming')}
                className={`px-6 py-3 border-b-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all hover:bg-gray-50 ${activeTab === 'Upcoming' ? 'border-primary text-primary font-bold' : 'border-transparent text-gray-medium font-semibold hover:text-dark'}`}
                aria-current={activeTab === 'Upcoming' ? 'page' : undefined}
              >
                Upcoming
              </button>
              <button 
                onClick={() => setActiveTab('My Tickets')}
                className={`px-6 py-3 border-b-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all hover:bg-gray-50 ${activeTab === 'My Tickets' ? 'border-primary text-primary font-bold' : 'border-transparent text-gray-medium font-semibold hover:text-dark'}`}
                aria-current={activeTab === 'My Tickets' ? 'page' : undefined}
              >
                My Tickets
              </button>
              <button 
                onClick={() => setActiveTab('Archive')}
                className={`px-6 py-3 border-b-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all hover:bg-gray-50 ${activeTab === 'Archive' ? 'border-primary text-primary font-bold' : 'border-transparent text-gray-medium font-semibold hover:text-dark'}`}
                aria-current={activeTab === 'Archive' ? 'page' : undefined}
              >
                Archive
              </button>
            </nav>

            {activeTab === 'Upcoming' && (
            <div className="space-y-8">
              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                </div>
              ) : sessions.filter(s => s.status !== 'archived').length > 0 ? (
                sessions.filter(s => s.status !== 'archived').map((s) => (
                  <section key={s.id} aria-labelledby={`course-${s.id}`}>
                    <h3 id={`course-${s.id}`} className="text-lg font-bold text-dark mb-4">{s.course}</h3>
                    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden transition-shadow hover:shadow-md">
                      {/* Session Row — always clickable on S1 */}
                      <div 
                        className="p-4 flex items-center justify-between cursor-pointer transition-all hover:bg-gray-50 active:bg-gray-100"
                        onClick={() => { setSelectedSessionId(s.id); setCurrentScreen('S2'); }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSessionId(s.id); setCurrentScreen('S2'); } }}
                        aria-label={`${s.time} session with ${s.host}, ${s.queueCount} tickets in queue`}
                      >
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                          <div className="font-semibold text-dark min-w-[120px]">{s.time}</div>
                          <div className="flex items-center gap-1.5 text-gray-medium">
                            <MapPin className="w-4 h-4" aria-hidden="true" />
                            <span>{s.location}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-medium">
                            <UserIcon className="w-4 h-4" aria-hidden="true" />
                            <span>{s.host}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-medium text-sm">{s.queueCount} tickets in queue</span>
                            {s.status === 'live' && (
                              <span className="flex items-center gap-1 px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold uppercase tracking-wider rounded animate-pulse">
                                <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                Live
                              </span>
                            )}
                          </div>
                          <ChevronRight className="w-5 h-5 text-gray-400" aria-hidden="true" />
                        </div>
                      </div>

                      {/* Attached Ticket Sub-row */}
                      {myTicket && myTicket.sessionId === s.id && (
                        <div className="bg-primary-light border-t border-primary/20 p-4 pl-8 flex items-center justify-between relative">
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary"></div>
                          <div className="flex items-center gap-6">
                            <div>
                              <div className="text-xs text-primary font-semibold uppercase tracking-wider mb-1">Your Ticket</div>
                              <div className="font-bold text-dark">Active</div>
                            </div>
                            <div>
                              <div className="text-sm font-medium text-dark">{myTicket.topic} · {myTicket.assignment}</div>
                              <div className="text-sm text-gray-medium">Est. wait: ~{s.estimatedWait} min</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <button 
                              onClick={(e) => { e.stopPropagation(); setSelectedSessionId(s.id); setCurrentScreen('S8'); }}
                              className="px-4 py-2 bg-primary text-white text-sm font-semibold rounded hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                            >
                              Join Live Queue
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); setSelectedSessionId(s.id); handleEditTicket(); }}
                              className="p-2 text-primary hover:bg-white rounded border border-transparent hover:border-primary/20 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                              aria-label="Edit ticket"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); setSelectedSessionId(s.id); handleDeleteTicket(); }}
                              className="p-2 text-error hover:bg-white rounded border border-transparent hover:border-error/20 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95"
                              aria-label="Delete ticket"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                ))
              ) : (
                <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                  <p className="text-gray-medium">No upcoming sessions found.</p>
                </div>
              )}
            </div>
            )}

            {activeTab === 'My Tickets' && (
              <div className="space-y-6">
                <h3 className="text-lg font-bold text-dark mb-4">Active & Recent Tickets</h3>
                {myTicket ? (
                  <div className="bg-white rounded-lg shadow-sm border border-primary p-6 relative overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary"></div>
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6 pl-2">
                      <div>
                        <span className="px-2 py-1 bg-primary-light text-primary text-xs font-bold uppercase tracking-wider rounded mb-3 inline-block">Active Ticket</span>
                        <h4 className="text-xl font-bold text-dark mb-1">{sessions.find(s => s.id === myTicket.sessionId)?.course}</h4>
                        <p className="text-dark font-medium">Ticket • {myTicket.topic} · {myTicket.assignment}</p>
                      </div>
                      <div className="sm:text-right bg-gray-50 p-3 rounded border border-gray-100">
                        <div className="text-2xl font-bold text-dark">~{sessions.find(s => s.id === myTicket.sessionId)?.estimatedWait} min</div>
                        <div className="text-xs text-gray-medium font-bold uppercase tracking-wider mt-1">Est. Wait</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 pl-2 border-t border-gray-100 pt-4">
                      <button onClick={() => { setSelectedSessionId(myTicket.sessionId); setCurrentScreen('S8'); }} className="px-5 py-2.5 bg-primary text-white font-bold rounded hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95">Join Live Queue</button>
                      <button onClick={() => { setSelectedSessionId(myTicket.sessionId); handleEditTicket(); }} className="px-5 py-2.5 border-2 border-primary text-primary font-bold rounded hover:bg-primary-light hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95">Edit Ticket</button>
                      <button onClick={() => { setSelectedSessionId(myTicket.sessionId); handleDeleteTicket(); }} className="px-5 py-2.5 border-2 border-error text-error font-bold rounded hover:bg-error/10 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95">Withdraw</button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                    <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <MessageSquare className="w-8 h-8 text-gray-400" aria-hidden="true" />
                    </div>
                    <h4 className="text-lg font-bold text-dark mb-2">No Active Tickets</h4>
                    <p className="text-gray-medium mb-6 max-w-sm mx-auto">You don't have any active tickets right now. Join a session queue to get help.</p>
                    <button onClick={() => setActiveTab('Upcoming')} className="px-6 py-3 bg-primary text-white font-bold rounded hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95">View Upcoming Sessions</button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'Archive' && (
              <div className="space-y-10">
                <section>
                  <h3 className="text-lg font-bold text-dark mb-6 flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-primary" />
                    My Past Tickets & Answers
                  </h3>
                  
                  {archivedTickets.length > 0 ? (
                    <div className="space-y-4">
                      {archivedTickets.map((ticket, idx) => (
                        <div key={idx} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                          <div className="p-6 border-b border-gray-50 flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <h4 className="text-lg font-bold text-dark">{ticket.session.course}</h4>
                                <span className="text-gray-medium">•</span>
                                <span className="text-sm text-gray-medium font-medium">{ticket.session.time}</span>
                              </div>
                              <p className="text-primary font-bold text-sm uppercase tracking-wider">{ticket.topic} · {ticket.assignment}</p>
                            </div>
                            <span className="px-3 py-1 bg-gray-100 text-gray-medium text-xs font-bold rounded-full border border-gray-200 uppercase tracking-widest">
                              {ticket.resolvedAt?.toDate ? ticket.resolvedAt.toDate().toLocaleDateString() : 'Recent'}
                            </span>
                          </div>
                          
                          <div className="p-6 space-y-6">
                            <div>
                              <h5 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-3">My Question</h5>
                              <div className="bg-gray-50 p-4 rounded-lg border border-gray-100 italic text-dark text-sm leading-relaxed">
                                "{ticket.summary}"
                              </div>
                            </div>

                            {ticket.taExplanation && (
                              <div className="bg-primary-light/20 p-5 rounded-xl border border-primary/10">
                                <h5 className="text-[10px] font-bold text-primary uppercase tracking-[0.2em] mb-3 flex items-center gap-2">
                                  <CheckCircle2 className="w-3 h-3" />
                                  TA Explanation
                                </h5>
                                <p className="text-dark leading-relaxed text-sm">{ticket.taExplanation}</p>
                              </div>
                            )}

                            <button 
                              onClick={() => {
                                setSelectedSessionId(ticket.session.id);
                                setViewingTicketId(ticket.id);
                                setCurrentScreen('S8');
                              }}
                              className="text-primary font-bold text-xs uppercase tracking-widest hover:underline flex items-center gap-1"
                            >
                              View Full Session History <ChevronRight className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                      <p className="text-gray-medium">No archived tickets found.</p>
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="text-lg font-bold text-dark mb-6 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-primary" />
                    All Past Sessions
                  </h3>
                  
                  {archivedSessions.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {archivedSessions.map((session) => (
                        <button 
                          key={session.id}
                          onClick={() => {
                            setSelectedSessionId(session.id);
                            setViewingTicketId(null);
                            setCurrentScreen('S8');
                          }}
                          className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-primary transition-all text-left group"
                        >
                          <div className="flex justify-between items-start mb-3">
                            <h4 className="font-bold text-dark group-hover:text-primary transition-colors">{session.course}</h4>
                            <span className="px-2 py-0.5 bg-gray-100 text-gray-medium text-[10px] font-bold rounded uppercase tracking-widest">Archived</span>
                          </div>
                          <p className="text-sm text-gray-medium mb-4">{session.title}</p>
                          <div className="flex items-center justify-between text-[10px] font-bold text-gray-medium uppercase tracking-widest">
                            <span>{session.time}</span>
                            <span className="flex items-center gap-1 text-primary">View Q&As <ChevronRight className="w-3 h-3" /></span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                      <p className="text-gray-medium">No archived sessions found.</p>
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* Guardrail Modal */}
            {isEditGuardrailOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="guardrail-title">
                <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                  <div className="flex items-start gap-4 mb-6">
                    <div className="p-2 bg-warning/10 text-warning rounded-full">
                      <AlertTriangle className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 id="guardrail-title" className="text-xl font-bold text-dark mb-2">Edit Ticket Warning</h2>
                      <p className="text-dark">Editing your ticket may cause your queue position to be recalculated. Are you sure you want to proceed?</p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3">
                    <button 
                      onClick={() => setIsEditGuardrailOpen(false)}
                      className="px-4 py-2 text-dark font-semibold hover:bg-gray-100 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={confirmEdit}
                      className="px-4 py-2 bg-primary text-white font-semibold rounded hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Proceed to Edit
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Delete Confirm Modal */}
            {isDeleteConfirmOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-title">
                <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                  <h2 id="delete-title" className="text-xl font-bold text-dark mb-4">Delete Ticket?</h2>
                  <p className="text-dark mb-6">Are you sure you want to remove your ticket from the queue? This action cannot be undone.</p>
                  <div className="flex justify-end gap-3">
                    <button 
                      onClick={() => setIsDeleteConfirmOpen(false)}
                      className="px-4 py-2 text-dark font-semibold hover:bg-gray-100 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={confirmDelete}
                      className="px-4 py-2 bg-error text-white font-semibold rounded hover:bg-error/90 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Delete Ticket
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        );

      case 'S2':
      case 'S3':
      case 'S4': {
        return (
          <main id="main-content" className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative">
            {/* S2 Content */}
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setCurrentScreen('S1')}
                  className="p-2 -ml-2 text-dark hover:bg-gray-100 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                  aria-label="Back to dashboard"
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <h2 className="text-2xl font-bold text-dark">{session.course} — {session.time}</h2>
              </div>
              {session.status === 'live' ? (
                <div className="flex items-center gap-1.5 px-3 py-1 bg-red-500 text-white text-sm font-bold uppercase tracking-widest rounded-full animate-pulse shadow-sm">
                  <div className="w-2 h-2 rounded-full bg-white" />
                  Live Now
                </div>
              ) : (
                <span className="px-3 py-1 bg-gray-100 text-gray-medium text-sm font-semibold rounded-full border border-gray-200">
                  {session.status === 'archived' ? 'Archived' : 'Not yet started'}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 flex flex-col items-center justify-center text-center">
                <Users className="w-8 h-8 text-primary mb-2" aria-hidden="true" />
                <div className="text-3xl font-bold text-dark mb-1">{session.queueCount}</div>
                <div className="text-sm text-gray-medium font-medium uppercase tracking-wide">In Queue</div>
              </div>
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 flex flex-col items-center justify-center text-center">
                <MessageSquare className="w-8 h-8 text-primary mb-2" aria-hidden="true" />
                <div className="text-3xl font-bold text-dark mb-1">{session.avgMin}</div>
                <div className="text-sm text-gray-medium font-medium uppercase tracking-wide">Avg Min / Student</div>
              </div>
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 flex flex-col items-center justify-center text-center">
                <Clock className="w-8 h-8 text-primary mb-2" aria-hidden="true" />
                <div className="text-3xl font-bold text-dark mb-1">{session.estWait}</div>
                <div className="text-sm text-gray-medium font-medium uppercase tracking-wide">Est. Wait (Min)</div>
              </div>
            </div>

            <section aria-labelledby="active-tags" className="mb-8">
              <h3 id="active-tags" className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Active Topic Tags</h3>
              {session.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {session.tags.map((tag: string) => (
                    <span key={tag} className="px-3 py-1.5 bg-gray-100 text-dark text-sm font-medium rounded-full border border-gray-200">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-gray-medium italic">No active tags yet.</p>
              )}
            </section>

            <div className="mb-12">
              {isSessionArchived ? (
                <div className="w-full md:w-auto px-8 py-4 bg-gray-200 text-gray-medium text-lg font-bold rounded-lg inline-block cursor-not-allowed">
                  Session Archived — Registration Closed
                </div>
              ) : (
                <button 
                  onClick={() => {
                    setSubmitError(null);
                    if (!selectedSessionId && session.id) {
                      setSelectedSessionId(session.id);
                    }
                    setCurrentScreen('S3');
                  }}
                  className="w-full md:w-auto px-8 py-4 bg-primary text-white text-lg font-bold rounded-lg shadow-md hover:bg-primary-hover hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                >
                  Pre-register for Queue
                </button>
              )}
            </div>

            <section aria-labelledby="queue-list" className="mb-8">
              <h3 id="queue-list" className="text-lg font-bold text-dark mb-4 border-b border-gray-200 pb-2">Current Queue ({session.tickets.filter(t => t.status === 'active').length})</h3>
              {session.tickets.filter(t => t.status === 'active').length > 0 ? (
                <div className="space-y-4">
                  {session.tickets
                    .filter(t => t.status === 'active')
                    .map((ticket: any, index: number) => (
                    <div 
                      key={ticket.id} 
                      onClick={() => {
                        setViewingTicketId(ticket.id);
                        setCurrentScreen('S8');
                      }}
                      className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex flex-col sm:flex-row gap-4 transition-all cursor-pointer hover:border-primary/50 hover:shadow-md active:scale-[0.99]"
                    >
                      <div className="shrink-0 w-12 h-12 rounded-full flex items-center justify-center font-bold bg-gray-100 text-gray-medium">
                        #{index + 1}
                      </div>
                      <div className="grow">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-bold text-dark">{ticket.topic}</span>
                          <span className="text-gray-300">•</span>
                          <span className="text-gray-medium text-sm">{ticket.assignment}</span>
                          {ticket.attendanceMode && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>}
                        </div>
                        <p className="line-clamp-2 text-dark">{ticket.summary}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-gray-50 p-8 rounded-lg border border-gray-200 text-center">
                  <p className="text-gray-medium">The queue is currently empty.</p>
                </div>
              )}
            </section>

            {/* S3 & S4 Modal Overlay */}
            {currentScreen === 'S3' && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="modal-title">
                <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full my-8 flex flex-col max-h-[90vh]">
                  <div className="p-6 border-b border-gray-200 flex items-center justify-between shrink-0">
                    <h2 id="modal-title" className="text-2xl font-bold text-dark">Submit a Ticket</h2>
                    <button 
                      onClick={() => setCurrentScreen('S2')}
                      className="p-2 text-gray-medium hover:bg-gray-100 hover:text-dark rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all hover:rotate-90 active:scale-95"
                      aria-label="Close modal"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                  
                  <div className="p-6 overflow-y-auto grow">
                    {submitError && (
                      <div className="mb-6 p-4 bg-error/10 border border-error/20 text-error rounded-lg flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        <p className="text-sm font-medium">{submitError}</p>
                      </div>
                    )}
                    <form id="ticket-form" className="space-y-6" onSubmit={handleSubmitTicket}>
                      
                      {/* Session Read-only */}
                      <div>
                        <label className="block text-sm font-bold text-dark mb-2">SESSION</label>
                        <div className="flex items-center justify-between bg-gray-50 p-3 rounded border border-gray-200">
                          <span className="font-medium text-dark">{session.course} — {session.time}</span>
                          <button type="button" onClick={() => { setCurrentScreen('S1'); }} className="text-primary text-sm font-semibold hover:underline hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors">Change</button>
                        </div>
                      </div>

                      {/* Topic */}
                      <div>
                        <label htmlFor="topic" className="block text-sm font-bold text-dark mb-2">QUESTION TOPIC</label>
                        <select 
                          id="topic"
                          value={topic}
                          onChange={(e) => setTopic(e.target.value)}
                          className="w-full p-3 border border-gray-300 rounded bg-white text-dark focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary hover:border-primary/50 transition-colors"
                          required
                        >
                          <option value="" disabled>Select topic...</option>
                          <option value="Conceptual">Conceptual</option>
                          <option value="Clarification">Clarification</option>
                          <option value="Debugging">Debugging</option>
                          <option value="Exam Prep">Exam Prep</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>

                      {/* Assignment — course-specific */}
                      <div>
                        <label htmlFor="assignment" className="block text-sm font-bold text-dark mb-2">RELATED ASSIGNMENT / TEST</label>
                        <select 
                          id="assignment"
                          value={assignment}
                          onChange={(e) => setAssignment(e.target.value)}
                          className="w-full p-3 border border-gray-300 rounded bg-white text-dark focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary hover:border-primary/50 transition-colors"
                          required
                        >
                          <option value="" disabled>Select deliverable...</option>
                          {getAssignmentOptions(session).map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      {/* Summary */}
                      <div>
                        <label htmlFor="summary" className="block text-sm font-bold text-dark mb-2">QUESTION SUMMARY</label>
                        <textarea 
                          id="summary"
                          value={summary}
                          onChange={(e) => setSummary(e.target.value)}
                          placeholder="Briefly describe your question and what you have already tried."
                          className="w-full p-3 border border-gray-300 rounded bg-white text-dark h-24 resize-none focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary hover:border-primary/50 transition-colors"
                          required
                        ></textarea>
                      </div>

                      {/* Help Type */}
                      <fieldset>
                        <legend className="block text-sm font-bold text-dark mb-3">What kind of help do you need?</legend>
                        <div className="space-y-3">
                          <label className={`flex items-start p-4 border rounded cursor-pointer transition-all hover:shadow-sm ${helpType === 'Quick Check' ? 'border-primary bg-primary-light' : 'border-gray-300 hover:border-gray-400'}`}>
                            <div className="flex items-center h-5">
                              <input 
                                type="radio" 
                                name="helpType" 
                                value="Quick Check"
                                checked={helpType === 'Quick Check'}
                                onChange={(e) => setHelpType(e.target.value)}
                                className="w-4 h-4 text-primary border-gray-300 focus:ring-primary"
                                required
                              />
                            </div>
                            <div className="ml-3">
                              <span className="block text-base font-bold text-dark">Quick Check</span>
                              <span className="block text-sm text-gray-medium mt-1">I have a specific bug or syntax error</span>
                            </div>
                          </label>
                          
                          <label className={`flex items-start p-4 border rounded cursor-pointer transition-all hover:shadow-sm ${helpType === 'Deep Dive' ? 'border-primary bg-primary-light' : 'border-gray-300 hover:border-gray-400'}`}>
                            <div className="flex items-center h-5">
                              <input 
                                type="radio" 
                                name="helpType" 
                                value="Deep Dive"
                                checked={helpType === 'Deep Dive'}
                                onChange={(e) => setHelpType(e.target.value)}
                                className="w-4 h-4 text-primary border-gray-300 focus:ring-primary"
                                required
                              />
                            </div>
                            <div className="ml-3">
                              <span className="block text-base font-bold text-dark">Deep Dive</span>
                              <span className="block text-sm text-gray-medium mt-1">I need a conceptual walkthrough of the idea</span>
                            </div>
                          </label>
                        </div>
                      </fieldset>

                      {/* R5: Attendance Mode */}
                      <fieldset>
                        <legend className="block text-sm font-bold text-dark mb-3">How are you attending?</legend>
                        <div className="flex gap-3">
                          <label className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-lg cursor-pointer transition-all hover:shadow-sm ${attendanceMode === 'in-person' ? 'border-primary bg-primary-light' : 'border-gray-300 hover:border-gray-400'}`}>
                            <input type="radio" name="attendanceMode" value="in-person" checked={attendanceMode === 'in-person'} onChange={(e) => setAttendanceMode(e.target.value as 'in-person' | 'online')} className="w-4 h-4 text-primary border-gray-300 focus:ring-primary" />
                            <span className="font-bold text-dark">In-Person</span>
                          </label>
                          <label className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-lg cursor-pointer transition-all hover:shadow-sm ${attendanceMode === 'online' ? 'border-primary bg-primary-light' : 'border-gray-300 hover:border-gray-400'}`}>
                            <input type="radio" name="attendanceMode" value="online" checked={attendanceMode === 'online'} onChange={(e) => setAttendanceMode(e.target.value as 'in-person' | 'online')} className="w-4 h-4 text-primary border-gray-300 focus:ring-primary" />
                            <span className="font-bold text-dark">Online</span>
                          </label>
                        </div>
                      </fieldset>

                      {helpType && (
                        <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-lg flex items-center gap-4 animate-in fade-in slide-in-from-top-2">
                          <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-sm shrink-0">
                            <Clock className="w-6 h-6 text-primary" />
                          </div>
                          <div>
                            <div className="flex items-baseline gap-2">
                              <span className="text-lg font-bold text-dark">
                                ~{Math.round(
                                  session.tickets
                                    .filter(t => t.status === 'active' && t.uid !== user?.uid)
                                    .reduce((sum, t) => sum + (session.avgMin || 5) * (t.helpType === 'Deep Dive' ? 1.5 : 0.7), 0)
                                )} min
                              </span>
                              <span className="text-xs font-bold text-primary uppercase tracking-wider">Estimated Wait</span>
                            </div>
                            <p className="text-xs text-gray-medium mt-0.5">
                              Calculated based on {session.queueCount} students currently in line.
                            </p>
                          </div>
                        </div>
                      )}


                      {/* Demo helper button to auto-fill */}
                      {currentScreen === 'S3' && (
                        <button 
                          type="button"
                          onClick={() => {
                            setTopic('Conceptual');
                            setAssignment('Assignment 2');
                            setSummary("Confused about how recursion unwinds the call stack. I've traced through the base case but can't visualize the return values.");
                            setHelpType('Deep Dive');
                            setAttendanceMode('in-person');
                          }}
                          className="text-sm text-primary underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors hover:text-primary-hover"
                        >
                          Auto-fill for Demo
                        </button>
                      )}

                      <div className="pt-6 border-t border-gray-200 flex justify-end gap-4">
                        <button 
                          type="button"
                          onClick={() => setCurrentScreen('S2')}
                          className="px-6 py-3 text-dark font-semibold hover:bg-gray-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                        >
                          Cancel
                        </button>
                        <button 
                          type="submit"
                          className="px-6 py-3 font-bold rounded shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95 flex items-center gap-2 bg-primary text-white hover:bg-primary-hover hover:shadow-md"
                        >
                          Submit Ticket →
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            )}
          </main>
        );
      }

      case 'S5':
        return (
          <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 flex flex-col items-center text-center min-h-[calc(100vh-64px)] justify-center">
            <CheckCircle2 className="w-20 h-20 text-primary mb-6" aria-hidden="true" />
            <h2 className="text-4xl font-bold text-dark mb-2">Ticket Submitted!</h2>
            <div className="text-5xl font-black text-dark mb-10 tracking-tight">#TX-{myTicket?.id?.substring(0, 3).toUpperCase() || '???'}</div>
            
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm w-full max-w-md p-6 mb-6 text-left">
              <dl className="space-y-4">
                <div className="flex justify-between border-b border-gray-100 pb-4">
                  <dt className="text-gray-medium font-semibold">Session</dt>
                  <dd className="text-dark font-bold">{session.time}</dd>
                </div>
                    <div className="flex justify-between border-b border-gray-100 pb-4">
                  <dt className="text-gray-medium font-semibold">Position</dt>
                  <dd className="text-dark font-bold">#{session.tickets.findIndex(t => t.uid === user?.uid) + 1 || session.queueCount + 1} in queue</dd>
                </div>
                <div className="flex justify-between border-b border-gray-100 pb-4">
                  <dt className="text-gray-medium font-semibold">Est. Wait</dt>
                  <dd className="text-dark font-bold">~{session.estimatedWait} min</dd>
                </div>
                <div className="flex justify-between border-b border-gray-100 pb-4">
                  <dt className="text-gray-medium font-semibold">Topic</dt>
                  <dd className="text-dark font-bold">{topic || 'Conceptual'} · {assignment || 'A2'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-medium font-semibold">Attendance</dt>
                  <dd className="text-dark font-bold">{attendanceMode === 'online' ? 'Online' : 'In-Person'}</dd>
                </div>
              </dl>
            </div>
            
            <p className="text-gray-medium italic mb-10 max-w-md">
              Your topic has been shared with the TA. They'll be ready when it's your turn.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
              <button 
                onClick={() => setCurrentScreen('S8')}
                className="flex-1 px-8 py-4 bg-primary text-white text-lg font-bold rounded-lg shadow-md hover:bg-primary-hover hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
              >
                Join Live Queue
              </button>
              <button 
                onClick={() => setCurrentScreen('S1')}
                className="flex-1 px-8 py-4 bg-white text-primary border-2 border-primary text-lg font-bold rounded-lg shadow-sm hover:bg-primary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
              >
                Dashboard
              </button>
            </div>
          </main>
        );

      case 'S8':
      case 'S9':
      case 'S10':
      case 'S11': {
        const activeTickets = session.tickets.filter(t => t.status === 'active');
        const resolvedTickets = session.tickets.filter(t => t.status === 'resolved');
        
        // Determine which ticket to show in the right panel (can be active or resolved)
        const allViewableTickets = [...activeTickets, ...resolvedTickets];
        const viewingTicket = viewingTicketId 
          ? allViewableTickets.find(t => t.id === viewingTicketId) || activeTickets[0]
          : activeTickets[0];
        const viewingTicketIndex = viewingTicket ? allViewableTickets.findIndex(t => t.id === viewingTicket.id) : -1;

        return (
          <main id="main-content" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative">
            <div className="mb-6">
              <button 
                onClick={() => { setCurrentScreen('S1'); setViewingTicketId(null); }}
                className="flex items-center gap-2 text-gray-medium hover:text-primary transition-colors font-semibold group"
              >
                <ArrowLeft className="w-5 h-5 transition-transform group-hover:-translate-x-1" />
                Back to Dashboard
              </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* Left Column: Queue List */}
              <div className="lg:col-span-5 space-y-6">
                
                {/* Persistent My Place Indicator */}
                {myTicket && !isSessionArchived ? (
                  <div className="sticky top-20 z-40 bg-white border-2 border-primary rounded-xl shadow-md p-5" aria-live="polite">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-bold text-primary flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-primary animate-pulse" aria-hidden="true"></span>
                        My Place
                      </h2>
                      <span className="px-3 py-1 bg-primary-light text-primary text-sm font-bold rounded-full">
                        #{activeTickets.findIndex(t => t.uid === user?.uid) + 1 || session.queueCount + 1}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                        <div className="text-xs text-gray-medium font-bold uppercase tracking-wider mb-1">Est. Wait</div>
                        <div className="font-bold text-dark text-xl">~{session.estimatedWait} min</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-medium font-bold uppercase tracking-wider mb-1">Topic</div>
                        <div className="font-bold text-dark text-sm truncate">{myTicket?.topic || topic || 'Conceptual'} · {myTicket?.assignment || assignment || 'A2'}</div>
                      </div>
                    </div>
                    <div className="flex gap-3 border-t border-gray-100 pt-4">
                      <button 
                        onClick={() => { setIsEditGuardrailOpen(true); }}
                        className="flex-1 py-2 text-primary font-semibold border border-primary rounded hover:bg-primary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                      >
                        Edit
                      </button>
                      <button 
                        onClick={() => setIsDeleteConfirmOpen(true)}
                        className="flex-1 py-2 text-error font-semibold border border-error rounded hover:bg-error/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95"
                      >
                        Withdraw
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="sticky top-20 z-40 bg-white border border-gray-200 rounded-xl shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-bold text-dark">{isSessionArchived ? 'Session Archived' : 'Not in Queue'}</h2>
                      <span className="px-3 py-1 bg-gray-100 text-gray-medium text-xs font-bold rounded-full uppercase tracking-wider">
                        {isSessionArchived ? 'History' : 'Observer'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-medium mb-4">
                      {isSessionArchived 
                        ? 'This session has ended. You can review all questions and answers that were discussed.' 
                        : 'You are currently viewing the live session. Join the queue to get personalized help from a TA.'}
                    </p>
                    {!isSessionArchived && (
                      <button 
                        onClick={() => setCurrentScreen('S3')}
                        className="w-full py-3 bg-primary text-white font-bold rounded-lg shadow-sm hover:bg-primary-hover transition-all active:scale-95"
                      >
                        Join Queue
                      </button>
                    )}
                  </div>
                )}

                {/* Queue List */}
                <section aria-labelledby="queue-list-heading">
                  <h3 id="queue-list-heading" className="text-xs font-bold text-gray-medium uppercase tracking-wider mb-3">Active Queue ({activeTickets.length})</h3>
                  <ol className="space-y-3">
                    {activeTickets.map((ticket, index) => (
                      <li 
                        key={ticket.id} 
                        className={`${ticket.uid === user?.uid ? 'bg-primary-light border-2 border-primary' : (viewingTicket?.id === ticket.id ? 'bg-blue-50 border-2 border-blue-300' : (index === 0 ? 'bg-gray-50' : 'bg-white'))} border border-gray-200 rounded-lg p-4 flex items-center gap-4 relative overflow-hidden cursor-pointer transition-all hover:shadow-md`}
                        onClick={() => setViewingTicketId(ticket.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingTicketId(ticket.id); } }}
                        aria-label={`View ticket from ${ticket.uid === user?.uid ? 'yourself' : `Student ${String.fromCharCode(65 + index)}`}: ${ticket.topic} · ${ticket.assignment}`}
                      >
                        {ticket.uid === user?.uid && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary"></div>}
                        {viewingTicket?.id === ticket.id && ticket.uid !== user?.uid && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-400"></div>}
                        <div className={`w-10 h-10 rounded-full ${ticket.uid === user?.uid ? 'bg-primary text-white' : (viewingTicket?.id === ticket.id ? 'bg-blue-200 text-blue-700' : (index === 0 ? 'bg-gray-200' : 'bg-gray-100'))} flex items-center justify-center font-bold text-gray-medium shrink-0`}>{index + 1}</div>
                        <div className="grow">
                          <div className="flex items-center gap-2">
                            <span className={`font-bold ${ticket.uid === user?.uid ? 'text-primary' : 'text-dark'}`}>{ticket.uid === user?.uid ? 'You' : `Student ${String.fromCharCode(65 + index)}`}</span>
                            {ticket.attendanceMode && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>}
                          </div>
                          <div className="text-sm text-gray-medium">{ticket.topic} · {ticket.assignment}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {index === 0 && <span className="px-2 py-1 bg-warning/20 text-warning-dark text-xs font-bold rounded uppercase tracking-wider">Now</span>}
                          <ChevronRight className={`w-4 h-4 transition-colors ${viewingTicket?.id === ticket.id ? 'text-primary' : 'text-gray-300'}`} />
                        </div>
                      </li>
                    ))}
                    {activeTickets.length === 0 && (
                      <li className="text-center py-8 text-gray-medium text-sm">Queue is empty.</li>
                    )}
                  </ol>
                </section>

                {/* Resolved Tickets */}
                {resolvedTickets.length > 0 && (
                  <section className="mt-6">
                    <h3 className="text-xs font-bold text-gray-medium uppercase tracking-wider mb-3">Answered ({resolvedTickets.length})</h3>
                    <ol className="space-y-2">
                      {resolvedTickets.map((ticket, index) => (
                        <li 
                          key={ticket.id} 
                          className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-3 cursor-pointer opacity-60 hover:opacity-100 transition-all"
                          onClick={() => setViewingTicketId(ticket.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingTicketId(ticket.id); } }}
                        >
                          <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                            <CheckCircle2 className="w-4 h-4" />
                          </div>
                          <div className="grow">
                            <span className="font-bold text-gray-medium text-sm">{ticket.uid === user?.uid ? 'You' : `Student ${String.fromCharCode(65 + index)}`}</span>
                            <div className="text-xs text-gray-medium">{ticket.topic} · {ticket.assignment}</div>
                          </div>
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-600 text-[10px] font-bold rounded uppercase">Answered</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>

              {/* Right Column: Active Question */}
              <div className="lg:col-span-7">
                <section aria-labelledby="active-question-heading" className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden sticky top-20">
                  <div className="bg-gray-50 border-b border-gray-200 p-6 flex items-center justify-between">
                    <div>
                      <h3 id="active-question-heading" className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-1">
                        {isSessionArchived ? 'Archived Question' : (viewingTicket?.status === 'resolved' ? 'Answered Question' : (viewingTicket && activeTickets.indexOf(viewingTicket) === 0 ? 'Active Question' : 'Queued Question'))}
                      </h3>
                      <div className="text-xl font-bold text-dark">{viewingTicket?.topic || 'Debugging'} · {viewingTicket?.assignment || 'A2'}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-medium mb-1">Student</div>
                      <div className="font-bold text-dark">
                        {viewingTicket?.uid === user?.uid ? 'You' : `Student ${String.fromCharCode(65 + viewingTicketIndex)}`}
                      </div>
                      {viewingTicket?.attendanceMode && (
                        <span className={`inline-block mt-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${viewingTicket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{viewingTicket.attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>
                      )}
                    </div>
                  </div>
                  
                  <div className="p-6 min-h-[300px] flex flex-col" aria-live="polite">
                    {/* Show the ticket summary */}
                    {viewingTicket && (
                      <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                        <h4 className="text-xs font-bold text-gray-medium uppercase tracking-wider mb-2">Question Summary</h4>
                        <p className="text-dark leading-relaxed">{viewingTicket.summary || 'No summary provided.'}</p>
                        <div className="mt-3 flex items-center gap-3 text-xs text-gray-medium">
                          <span className="px-2 py-0.5 bg-gray-100 rounded font-semibold">{viewingTicket.helpType || 'General'}</span>
                          <span>#{viewingTicketIndex + 1} in queue</span>
                        </div>
                      </div>
                    )}

                    {(() => {
                      const hasExplanation = !!viewingTicket?.taExplanation;
                      
                      if (!hasExplanation) {
                        return (
                          <div className="flex-1 flex flex-col items-center justify-center text-center text-gray-medium">
                            <MessageSquare className="w-12 h-12 mb-4 opacity-20" aria-hidden="true" />
                            <p className="max-w-sm">Follow along in person or wait for the TA to add their explanation here.</p>
                            
                            {/* Demo trigger — only for non-archived sessions */}
                            {viewingTicket && !isSessionArchived && (
                              <button 
                                onClick={async () => {
                                  try {
                                    await updateDoc(
                                      doc(db, 'sessions', session.id, 'tickets', viewingTicket.id),
                                      { taExplanation: "Each recursive call pushes a frame onto the stack. When the base case is hit, frames pop in reverse order, returning values up the chain." }
                                    );
                                  } catch (error) {
                                    console.error('Error simulating TA explanation:', error);
                                  }
                                }}
                                className="mt-8 text-sm text-primary underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors hover:text-primary-hover"
                              >
                                Simulate TA Explanation (Demo)
                              </button>
                            )}
                          </div>
                        );
                      }

                      return (
                        <div className="flex-1 flex flex-col">
                          <div className="bg-primary-light/30 border border-primary/20 rounded-lg p-6 mb-6">
                            <h4 className="text-sm font-bold text-primary uppercase tracking-wider mb-3 flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-primary" aria-hidden="true"></span>
                              TA Explanation
                            </h4>
                            <p className="text-dark text-lg leading-relaxed">
                              {viewingTicket.taExplanation}
                            </p>
                          </div>
                          
                          {/* Only show "does this answer your question" for non-archived, non-own tickets, when user has active ticket */}
                          {!isSessionArchived && viewingTicket?.uid !== user?.uid && myTicket && (
                            <div className="mt-auto text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                              <p className="text-dark font-semibold mb-4 text-lg">Does this answer your question too?</p>
                              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                                <button 
                                  onClick={() => setCurrentScreen('S11')}
                                  className="px-6 py-3 bg-primary text-white font-bold rounded-lg shadow-sm hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95 flex items-center justify-center gap-2"
                                >
                                  <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                                  Yes, Withdraw My Ticket
                                </button>
                                <button 
                                  onClick={() => {
                                    setViewingTicketId(null);
                                  }}
                                  className="px-6 py-3 border-2 border-gray-300 text-dark font-bold rounded-lg hover:bg-gray-50 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95 flex items-center justify-center gap-2"
                                >
                                  <X className="w-5 h-5" aria-hidden="true" />
                                  No, Keep My Place
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </section>
              </div>
            </div>

            {/* S11: Confirm Leave Queue Modal */}
            {currentScreen === 'S11' && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="leave-title">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 text-center">
                  <h2 id="leave-title" className="text-2xl font-bold text-dark mb-4">Leave the Queue?</h2>
                  <p className="text-dark mb-8 text-lg">
                    Your ticket will be removed from the queue. The question and answer will be saved under this session for you to review later.
                  </p>
                  <div className="flex flex-col gap-4">
                    <button 
                      onClick={async () => {
                        if (myTicket) {
                          await updateDoc(doc(db, 'sessions', myTicket.sessionId, 'tickets', myTicket.id), { 
                            status: 'resolved',
                            resolvedAt: serverTimestamp()
                          });
                        }
                        setViewingTicketId(null);
                        setCurrentScreen('S12');
                      }}
                      className="w-full px-6 py-4 bg-primary text-white text-lg font-bold rounded-lg hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Confirm — Leave Queue
                    </button>
                    <button 
                      onClick={() => setCurrentScreen('S10')}
                      className="w-full px-6 py-3 text-primary font-semibold hover:underline hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Re-use Guardrail and Delete Modals for S8 */}
            {isEditGuardrailOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="guardrail-title">
                <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                  <div className="flex items-start gap-4 mb-6">
                    <div className="p-2 bg-warning/10 text-warning rounded-full">
                      <AlertTriangle className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <div>
                      <h2 id="guardrail-title" className="text-xl font-bold text-dark mb-2">Edit Ticket Warning</h2>
                      <p className="text-dark">Editing your ticket may cause your queue position to be recalculated. Are you sure you want to proceed?</p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3">
                    <button 
                      onClick={() => setIsEditGuardrailOpen(false)}
                      className="px-4 py-2 text-dark font-semibold hover:bg-gray-100 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={() => {
                        setIsEditGuardrailOpen(false);
                        if (myTicket) {
                          setTopic(myTicket.topic);
                          setAssignment(myTicket.assignment);
                          setSummary(myTicket.summary);
                          setHelpType(myTicket.helpType);
                          setAttendanceMode(myTicket.attendanceMode || 'in-person');
                        }
                        setCurrentScreen('S3');
                      }}
                      className="px-4 py-2 bg-primary text-white font-semibold rounded hover:bg-primary-hover hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Proceed to Edit
                    </button>
                  </div>
                </div>
              </div>
            )}

            {isDeleteConfirmOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-title">
                <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                  <h2 id="delete-title" className="text-xl font-bold text-dark mb-4">Withdraw from Queue?</h2>
                  <p className="text-dark mb-6">Are you sure you want to withdraw your ticket? You will lose your spot in the queue.</p>
                  <div className="flex justify-end gap-3">
                    <button 
                      onClick={() => setIsDeleteConfirmOpen(false)}
                      className="px-4 py-2 text-dark font-semibold hover:bg-gray-100 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={() => {
                        setIsDeleteConfirmOpen(false);
                        confirmDelete();
                      }}
                      className="px-4 py-2 bg-error text-white font-semibold rounded hover:bg-error/90 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95"
                    >
                      Withdraw
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        );
      }

      case 'TA_DASHBOARD':
        return (
          <main className="min-h-screen bg-gray-50 pb-12">
            {/* Header */}
            <header className="bg-primary text-white p-4 shadow-md sticky top-0 z-30">
              <div className="max-w-7xl mx-auto flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-black tracking-tighter uppercase">SmartQueue</h1>
                  <span className="px-2 py-0.5 bg-white/20 rounded text-[10px] font-bold uppercase tracking-widest">TA</span>
                  {schoolName && (
                    <span className="hidden sm:inline text-sm text-white/60">· {schoolName}</span>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {userProfile?.schoolId && (
                    <button
                      onClick={copySchoolId}
                      className="hidden sm:flex items-center gap-1.5 text-white/70 hover:text-white text-xs font-mono bg-white/10 px-2.5 py-1.5 rounded-lg transition-colors"
                      title="Click to copy School ID for students"
                    >
                      <Hash className="w-3 h-3" />
                      {userProfile.schoolId}
                      <Copy className="w-3 h-3" />
                    </button>
                  )}
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">
                    {userProfile?.displayName?.substring(0, 2).toUpperCase() || user?.email?.substring(0, 2).toUpperCase() || 'TA'}
                  </div>
                  <button onClick={logout} className="p-2 hover:bg-white/10 rounded-full transition-colors" aria-label="Logout">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="max-w-7xl mx-auto px-4 pt-8">
              {/* Admin Reset/Seeding (Only for TAs) */}
              {isTA && (
                <div className="mb-8 p-6 bg-primary-light rounded-xl border-2 border-dashed border-primary flex flex-col items-center text-center">
                  <h3 className="text-lg font-bold text-primary mb-2">TA Controls</h3>
                  <p className="text-dark mb-4">Reset the system to the base state (3 default sessions, no tickets).</p>
                  
                  {resetStatus && (
                    <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 ${resetStatus.type === 'success' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
                      {resetStatus.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <span className="font-medium">{resetStatus.message}</span>
                    </div>
                  )}

                  <button 
                    onClick={() => {
                      if (sessions.length > 0) {
                        setIsResetConfirmOpen(true);
                      } else {
                        handleSeedData();
                      }
                    }}
                    disabled={isSeeding}
                    className="px-6 py-3 bg-primary text-white font-bold rounded-lg flex items-center gap-2 hover:bg-primary-hover disabled:opacity-50 transition-all active:scale-95"
                  >
                    {isSeeding ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Reset & Seed All Data'}
                  </button>
                </div>
              )}

              {/* Admin Reset Confirmation Modal */}
              {isResetConfirmOpen && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true">
                  <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 text-center">
                    <div className="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto mb-6">
                      <AlertTriangle className="w-8 h-8" />
                    </div>
                    <h2 className="text-2xl font-bold text-dark mb-4">Reset All Data?</h2>
                    <p className="text-dark mb-8 text-lg">
                      This will permanently delete all existing sessions and all student tickets. This action cannot be undone.
                    </p>
                    <div className="flex flex-col gap-4">
                      <button 
                        onClick={handleSeedData}
                        disabled={isSeeding}
                        className="w-full px-6 py-4 bg-error text-white text-lg font-bold rounded-lg hover:bg-error/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 transition-all active:scale-95 flex items-center justify-center gap-2"
                      >
                        {isSeeding ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Yes, Reset Everything'}
                      </button>
                      <button 
                        onClick={() => setIsResetConfirmOpen(false)}
                        disabled={isSeeding}
                        className="w-full px-6 py-3 text-gray-medium font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <nav className="flex border-b border-gray-200 mb-8" aria-label="Dashboard tabs">
                {['My Sessions', 'Archive', 'Analytics'].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setTaActiveTab(tab as any)}
                    className={`px-6 py-4 text-sm font-bold uppercase tracking-wider transition-all relative ${
                      taActiveTab === tab ? 'text-primary' : 'text-gray-medium hover:text-dark'
                    }`}
                  >
                    {tab}
                    {taActiveTab === tab && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary rounded-t-full" />
                    )}
                  </button>
                ))}
              </nav>

              {taActiveTab === 'My Sessions' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl font-bold text-dark">Upcoming Sessions</h2>
                    <button 
                      onClick={() => setIsAddSessionModalOpen(true)}
                      className="px-4 py-2 bg-primary text-white font-bold rounded-lg flex items-center gap-2 hover:bg-primary-hover transition-all active:scale-95 shadow-sm"
                    >
                      <Edit2 className="w-4 h-4" />
                      Add Session
                    </button>
                  </div>

                  <div className="grid gap-4">
                    {sessions.filter(s => s.status !== 'archived').map((session) => (
                      <button
                        key={session.id}
                        onClick={() => {
                          setSelectedSessionId(session.id);
                          if (session.status === 'live') {
                            // Already live — resume directly into the live view
                            setCurrentScreen('TA_SESSION_LIVE');
                          } else {
                            // Upcoming — go to the detail page so the TA can review
                            // and explicitly click "Start Session" themselves.
                            setCurrentScreen('TA_SESSION_DETAIL');
                          }
                        }}
                        className="w-full bg-white p-6 rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-primary/30 transition-all text-left flex items-center justify-between group relative overflow-hidden"
                      >
                        {session.status === 'live' && (
                          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-red-500 animate-pulse" />
                        )}
                        <div className="flex items-start gap-4">
                          <div className={`p-3 rounded-lg ${session.status === 'live' ? 'bg-red-50 text-red-500' : 'bg-primary-light text-primary'} group-hover:scale-110 transition-transform`}>
                            {session.status === 'live' ? <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse" /> : <Clock className="w-6 h-6" />}
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="text-xl font-bold text-dark">{session.course} — {session.title}</h3>
                              {session.status === 'live' && (
                                <span className="px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold uppercase tracking-widest rounded animate-pulse">Live</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-4 text-sm text-gray-medium">
                              <span className="flex items-center gap-1.5">
                                <MapPin className="w-4 h-4 text-primary" />
                                {session.location}
                              </span>
                              <span className="flex items-center gap-1.5">
                                <Clock className="w-4 h-4 text-primary" />
                                {session.time}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="px-4 py-2 bg-primary-light rounded-full text-primary font-bold text-sm">
                            {session.tickets?.filter(t => t.status === 'active').length || 0} tickets
                          </div>
                          <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-primary transition-colors" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {taActiveTab === 'Archive' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <h2 className="text-2xl font-bold text-dark mb-6">Archived Sessions</h2>
                  <div className="grid gap-4">
                    {sessions.filter(s => s.status === 'archived').map((session) => (
                      <div
                        key={session.id}
                        className="w-full bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center justify-between"
                      >
                        <div className="flex items-start gap-4">
                          <div className="p-3 bg-gray-100 rounded-lg text-gray-400">
                            <Clock className="w-6 h-6" />
                          </div>
                          <div>
                            <h3 className="text-xl font-bold text-dark mb-1">{session.course} — {session.title}</h3>
                            <div className="flex flex-wrap gap-4 text-sm text-gray-medium">
                              <span className="flex items-center gap-1.5">
                                <MapPin className="w-4 h-4" />
                                {session.location}
                              </span>
                              <span className="flex items-center gap-1.5">
                                <Clock className="w-4 h-4" />
                                {session.time}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="px-4 py-2 bg-gray-100 rounded-full text-gray-medium font-bold text-sm">
                          Archived
                        </div>
                      </div>
                    ))}
                    {sessions.filter(s => s.status === 'archived').length === 0 && (
                      <div className="text-center py-20 bg-white rounded-2xl border-2 border-dashed border-gray-200">
                        <Clock className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                        <h3 className="text-xl font-bold text-dark mb-2">No Archived Sessions</h3>
                        <p className="text-gray-medium">Completed office hours sessions will appear here.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {taActiveTab === 'Analytics' && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
                  <h2 className="text-2xl font-bold text-dark">Analytics Overview</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm text-center">
                      <div className="text-3xl font-bold text-dark">{analyticsData.totalTickets}</div>
                      <div className="text-xs font-bold text-gray-medium uppercase tracking-wider mt-1">Total Tickets</div>
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm text-center">
                      <div className="text-3xl font-bold text-emerald-600">{analyticsData.resolvedCount}</div>
                      <div className="text-xs font-bold text-gray-medium uppercase tracking-wider mt-1">Resolved</div>
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm text-center">
                      <div className="text-3xl font-bold text-primary">{analyticsData.activeCount}</div>
                      <div className="text-xs font-bold text-gray-medium uppercase tracking-wider mt-1">Active</div>
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm text-center">
                      <div className="text-3xl font-bold text-dark">{analyticsData.avgResolutionMin || '\u2014'}</div>
                      <div className="text-xs font-bold text-gray-medium uppercase tracking-wider mt-1">Avg Resolve (min)</div>
                    </div>
                  </div>
                  <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <h3 className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Sessions</h3>
                    <div className="flex gap-6 text-sm">
                      <span className="text-dark"><strong>{analyticsData.upcomingSessions}</strong> upcoming</span>
                      <span className="text-red-500"><strong>{analyticsData.liveSessions}</strong> live</span>
                      <span className="text-gray-medium"><strong>{analyticsData.archivedSessions}</strong> archived</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                      <h3 className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Tickets by Topic</h3>
                      {Object.keys(analyticsData.byTopic).length > 0 ? <BarChart data={analyticsData.byTopic} color="bg-primary" /> : <p className="text-gray-medium text-sm">No data yet.</p>}
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                      <h3 className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Tickets by Help Type</h3>
                      {Object.keys(analyticsData.byHelpType).length > 0 ? <BarChart data={analyticsData.byHelpType} color="bg-indigo-500" /> : <p className="text-gray-medium text-sm">No data yet.</p>}
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                      <h3 className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Tickets by Course</h3>
                      {Object.keys(analyticsData.byCourse).length > 0 ? <BarChart data={analyticsData.byCourse} color="bg-emerald-500" /> : <p className="text-gray-medium text-sm">No data yet.</p>}
                    </div>
                    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                      <h3 className="text-sm font-bold text-gray-medium uppercase tracking-wider mb-4">Attendance Mode</h3>
                      {analyticsData.totalTickets > 0 ? <BarChart data={analyticsData.byMode} color="bg-blue-500" /> : <p className="text-gray-medium text-sm">No data yet.</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Add Session Modal */}
            {isAddSessionModalOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
                <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-8 my-8">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl font-bold text-dark">New Office Hours Session</h2>
                    <button onClick={() => setIsAddSessionModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                  <form onSubmit={handleAddSession} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Course Code</label>
                        <input
                          required
                          value={newSessionForm.course}
                          onChange={e => setNewSessionForm({...newSessionForm, course: e.target.value})}
                          placeholder="e.g. CSC369"
                          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Session Title</label>
                        <input
                          required
                          value={newSessionForm.title}
                          onChange={e => setNewSessionForm({...newSessionForm, title: e.target.value})}
                          placeholder="e.g. Operating Systems"
                          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Time / Date</label>
                      <input
                        required
                        value={newSessionForm.time}
                        onChange={e => setNewSessionForm({...newSessionForm, time: e.target.value})}
                        placeholder="e.g. Today, 2:00 PM"
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Location</label>
                      <input
                        required
                        value={newSessionForm.location}
                        onChange={e => setNewSessionForm({...newSessionForm, location: e.target.value})}
                        placeholder="e.g. BA3185"
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Host / TA Name</label>
                      <input
                        required
                        value={newSessionForm.host}
                        onChange={e => setNewSessionForm({...newSessionForm, host: e.target.value})}
                        placeholder="e.g. TA: Sarah J."
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Avg. Minutes Per Student</label>
                      <input
                        type="number"
                        required
                        value={newSessionForm.avgMin}
                        onChange={e => setNewSessionForm({...newSessionForm, avgMin: parseInt(e.target.value, 10)})}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold uppercase tracking-wider text-gray-medium">Tags (comma separated)</label>
                      <input
                        value={newSessionForm.tags}
                        onChange={e => setNewSessionForm({...newSessionForm, tags: e.target.value})}
                        placeholder="Homework 3, Exam Review, Concept Review"
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all"
                      />
                    </div>
                    <div className="pt-4 flex gap-3">
                      <button
                        type="button"
                        onClick={() => setIsAddSessionModalOpen(false)}
                        className="flex-1 px-6 py-3 border-2 border-gray-200 text-dark font-bold rounded-lg hover:bg-gray-50 transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="flex-1 px-6 py-3 bg-primary text-white font-bold rounded-lg hover:bg-primary-hover shadow-md transition-all active:scale-95"
                      >
                        Create Session
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </main>
        );

      case 'TA_SESSION_DETAIL': {
        const session = sessions.find(s => s.id === selectedSessionId);
        if (!session) return <div>Session not found</div>;

        return (
          <main className="min-h-screen bg-gray-50 pb-12">
            {/* Header */}
            <header className="bg-primary text-white p-4 shadow-md sticky top-0 z-30">
              <div className="max-w-7xl mx-auto flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-black tracking-tighter uppercase">SmartQueue</h1>
                  <span className="px-2 py-0.5 bg-white/20 rounded text-[10px] font-bold uppercase tracking-widest">TA</span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">
                    {userProfile?.displayName?.substring(0, 2).toUpperCase() || user?.email?.substring(0, 2).toUpperCase() || 'TA'}
                  </div>
                  <button onClick={logout} className="p-2 hover:bg-white/10 rounded-full transition-colors" aria-label="Logout">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="max-w-3xl mx-auto px-4 pt-8">
              <button 
                onClick={() => setCurrentScreen('TA_DASHBOARD')}
                className="flex items-center gap-2 text-gray-medium hover:text-primary transition-colors mb-6 font-bold uppercase tracking-wider text-xs"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>

              <div className="flex items-center justify-between mb-8">
                <div>
                  <h2 className="text-3xl font-bold text-dark">{session.course} — {session.title}</h2>
                  <p className="text-gray-medium">{session.time} • {session.location}</p>
                </div>
                <button 
                  onClick={() => {
                    if (session.status === 'live') {
                      setCurrentScreen('TA_SESSION_LIVE');
                    } else {
                      handleStartSession(session.id);
                    }
                  }}
                  className={`px-6 py-3 ${session.status === 'live' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-primary hover:bg-primary-hover'} text-white font-bold rounded-lg flex items-center gap-2 shadow-md transition-all active:scale-95`}
                >
                  {session.status === 'live' ? <CheckCircle2 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                  {session.status === 'live' ? 'Resume Session' : 'Start Session'}
                </button>
              </div>

              {/* R3: View mode toggle */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs font-bold text-gray-medium uppercase tracking-wider">View:</span>
                <button onClick={() => setTaQueueViewMode('list')} className={`px-3 py-1.5 text-xs font-bold rounded-full transition-all ${taQueueViewMode === 'list' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-medium hover:bg-gray-200'}`}>List</button>
                <button onClick={() => setTaQueueViewMode('grouped')} className={`px-3 py-1.5 text-xs font-bold rounded-full transition-all ${taQueueViewMode === 'grouped' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-medium hover:bg-gray-200'}`}>Grouped by Topic</button>
              </div>

              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                  <h3 className="text-sm font-bold text-gray-medium uppercase tracking-widest">
                    Submitted Tickets ({session.tickets?.filter(t => t.status === 'active').length || 0})
                  </h3>
                </div>

                {taQueueViewMode === 'list' ? (
                <div className="divide-y divide-gray-100">
                  {session.tickets?.filter(t => t.status === 'active').map((ticket, idx) => (
                    <button
                      key={ticket.id}
                      onClick={() => { setViewingTicketId(ticket.id); setCurrentScreen('TA_TICKET_DETAIL'); }}
                      className="w-full p-6 hover:bg-gray-50 transition-colors text-left flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-6">
                        <span className="text-xs font-mono text-gray-medium">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-bold text-dark">Student {String.fromCharCode(65 + idx)}</h4>
                            {ticket.attendanceMode && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>}
                          </div>
                          <div className="flex gap-2">
                            <span className="px-2 py-0.5 bg-primary-light text-primary text-[10px] font-bold rounded uppercase">{ticket.topic}</span>
                            <span className="px-2 py-0.5 bg-gray-100 text-gray-medium text-[10px] font-bold rounded uppercase">{ticket.assignment}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs font-bold text-warning uppercase tracking-wider">{ticket.helpType}</span>
                        <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-primary transition-colors" />
                      </div>
                    </button>
                  ))}
                  {(!session.tickets || session.tickets.filter(t => t.status === 'active').length === 0) && (
                    <div className="p-12 text-center text-gray-medium">No active tickets in queue.</div>
                  )}
                </div>
                ) : (
                /* R3: Cluster-based grouped view, powered by useTicketClusters */
                <div className="p-6 space-y-6">
                  {clustersLoading && !clusterResult ? (
                    <div className="text-center py-12 text-gray-medium">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                      <p className="text-sm">Warming up clustering model...</p>
                      <p className="text-xs mt-1 opacity-70">~14MB, cached after first load</p>
                    </div>
                  ) : !clusterResult || (clusterResult.clusters.length === 0 && clusterResult.noiseTicketIds.length === 0) ? (
                    <div className="text-center text-gray-medium py-8">No active tickets.</div>
                  ) : (
                    <>
                      {clusterResult.clusters.map((cluster, displayIdx) => {
                        const clusterTickets = cluster.ticketIds
                          .map(id => session.tickets.find(t => t.id === id))
                          .filter((t): t is Ticket => !!t);
                        const activeTickets = session.tickets.filter(t => t.status === 'active');
                        return (
                          <div key={cluster.id} className="border border-gray-200 rounded-xl overflow-hidden">
                            <div className="bg-primary-light/50 px-5 py-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="px-2.5 py-1 bg-primary text-white text-xs font-bold rounded uppercase shrink-0">
                                  Cluster {displayIdx + 1}
                                </span>
                                <span className="text-sm font-bold text-dark truncate">{cluster.label}</span>
                              </div>
                              <span className="text-xs text-gray-medium font-bold uppercase tracking-wider shrink-0">
                                {clusterTickets.length} similar · batch-address
                              </span>
                            </div>
                            <div className="divide-y divide-gray-100">
                              {clusterTickets.map((ticket) => (
                                <button
                                  key={ticket.id}
                                  onClick={() => { setViewingTicketId(ticket.id); setCurrentScreen('TA_TICKET_DETAIL'); }}
                                  className="w-full px-5 py-4 hover:bg-gray-50 text-left flex items-center justify-between group"
                                >
                                  <div className="flex items-center gap-4">
                                    <span className="text-xs font-mono text-gray-medium">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
                                    <div>
                                      <div className="flex items-center gap-2">
                                        <span className="font-bold text-dark text-sm">Student {String.fromCharCode(65 + activeTickets.indexOf(ticket))}</span>
                                        {ticket.attendanceMode && (
                                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                            {ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}
                                          </span>
                                        )}
                                      </div>
                                      <span className="text-xs text-gray-medium">{ticket.topic} · {ticket.assignment} · {ticket.helpType}</span>
                                    </div>
                                  </div>
                                  <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-primary" />
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}

                      {clusterResult.noiseTicketIds.length > 0 && (
                        <div className="border border-gray-200 rounded-xl overflow-hidden">
                          <div className="bg-gray-100 px-5 py-3 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="px-2.5 py-1 bg-gray-400 text-white text-xs font-bold rounded uppercase">Other</span>
                              <span className="text-sm font-bold text-dark">Unique questions</span>
                            </div>
                            <span className="text-xs text-gray-medium font-bold uppercase tracking-wider">
                              {clusterResult.noiseTicketIds.length} ticket{clusterResult.noiseTicketIds.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="divide-y divide-gray-100">
                            {clusterResult.noiseTicketIds.map(tid => {
                              const ticket = session.tickets.find(t => t.id === tid);
                              if (!ticket) return null;
                              const activeTickets = session.tickets.filter(t => t.status === 'active');
                              return (
                                <button
                                  key={ticket.id}
                                  onClick={() => { setViewingTicketId(ticket.id); setCurrentScreen('TA_TICKET_DETAIL'); }}
                                  className="w-full px-5 py-4 hover:bg-gray-50 text-left flex items-center justify-between group"
                                >
                                  <div className="flex items-center gap-4">
                                    <span className="text-xs font-mono text-gray-medium">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
                                    <div>
                                      <span className="font-bold text-dark text-sm">Student {String.fromCharCode(65 + activeTickets.indexOf(ticket))}</span>
                                      <div className="text-xs text-gray-medium">{ticket.topic} · {ticket.assignment}</div>
                                    </div>
                                  </div>
                                  <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-primary" />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                )}
              </div>
            </div>
          </main>
        );
      }

      case 'TA_TICKET_DETAIL': {
        const session = sessions.find(s => s.id === selectedSessionId);
        const ticket = session?.tickets.find(t => t.id === viewingTicketId);
        if (!session || !ticket) return <div>Ticket not found</div>;

        return (
          <main className="min-h-screen bg-gray-50 pb-12">
            {/* Header */}
            <header className="bg-primary text-white p-4 shadow-md sticky top-0 z-30">
              <div className="max-w-7xl mx-auto flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-black tracking-tighter uppercase">SmartQueue</h1>
                  <span className="px-2 py-0.5 bg-white/20 rounded text-[10px] font-bold uppercase tracking-widest">TA</span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">
                    {userProfile?.displayName?.substring(0, 2).toUpperCase() || user?.email?.substring(0, 2).toUpperCase() || 'TA'}
                  </div>
                  <button onClick={logout} className="p-2 hover:bg-white/10 rounded-full transition-colors" aria-label="Logout">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="max-w-3xl mx-auto px-4 pt-8">
              <button 
                onClick={() => setCurrentScreen('TA_SESSION_DETAIL')}
                className="flex items-center gap-2 text-gray-medium hover:text-primary transition-colors mb-6 font-bold uppercase tracking-wider text-xs"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Ticket List
              </button>

              <div className="bg-white rounded-2xl border border-gray-200 shadow-lg overflow-hidden">
                <div className="p-8 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                  <div className="flex gap-2">
                    <span className="px-3 py-1 bg-primary-light text-primary text-xs font-bold rounded-full uppercase">{ticket.topic}</span>
                    <span className="px-3 py-1 bg-gray-200 text-gray-medium text-xs font-bold rounded-full uppercase">{ticket.assignment}</span>
                    <span className="px-3 py-1 bg-warning/10 text-warning text-xs font-bold rounded-full uppercase">{ticket.helpType}</span>
                    {ticket.attendanceMode && <span className={`px-3 py-1 text-xs font-bold rounded-full uppercase ${ticket.attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{ticket.attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>}
                  </div>
                  <span className="text-sm font-mono text-gray-medium font-bold">#TX-{ticket.id.substring(0, 3).toUpperCase()}</span>
                </div>
                
                <div className="p-8 space-y-8">
                  <section>
                    <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-2">Student</h3>
                    <p className="text-xl font-bold text-dark">Student A (Anonymous)</p>
                  </section>

                  <div className="grid grid-cols-2 gap-8">
                    <section>
                      <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-2">Topic</h3>
                      <p className="font-semibold text-dark">{ticket.topic}</p>
                    </section>
                    <section>
                      <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-2">Assignment</h3>
                      <p className="font-semibold text-dark">{ticket.assignment}</p>
                    </section>
                  </div>

                  <section>
                    <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-2">Complexity</h3>
                    <p className="font-semibold text-dark">{ticket.helpType}</p>
                  </section>

                  <section>
                    <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-2">Question Summary</h3>
                    <div className="bg-gray-50 p-6 rounded-xl border border-gray-100 italic text-dark leading-relaxed">
                      "{ticket.summary}"
                    </div>
                  </section>

                  <div className="pt-8 flex gap-4">
                    <button 
                      onClick={() => setCurrentScreen('TA_SESSION_DETAIL')}
                      className="flex-1 px-6 py-4 border-2 border-gray-200 text-dark font-bold rounded-xl hover:bg-gray-50 transition-all active:scale-95"
                    >
                      Back
                    </button>
                    <button 
                      onClick={async () => {
                        await handleMarkUpNext(session.id, ticket.id);
                        setCurrentScreen('TA_SESSION_DETAIL');
                      }}
                      className="flex-[2] px-6 py-4 bg-primary text-white font-bold rounded-xl shadow-md hover:bg-primary-hover transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      Mark Up Next ↑
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </main>
        );
      }

      case 'TA_SESSION_LIVE': {
        const session: Session | undefined = sessions.find(s => s.id === selectedSessionId);
        if (!session) return <div>Session not found</div>;

        const activeTickets = session.tickets?.filter(t => t.status === 'active') || [];
        const queueTickets = activeTickets.slice(1);
        const answeredTickets = session.tickets?.filter(t => t.status === 'resolved')
          .sort((a, b) => {
            const timeA = a.resolvedAt?.toDate?.()?.getTime() || 0;
            const timeB = b.resolvedAt?.toDate?.()?.getTime() || 0;
            return timeB - timeA;
          }) || [];

        const handleDragEnd = async (event: DragEndEvent) => {
          const { active, over } = event;
          if (!over || active.id === over.id) return;

          const oldIndex = queueTickets.findIndex((t: Ticket) => t.id === active.id);
          const newIndex = queueTickets.findIndex((t: Ticket) => t.id === over.id);

          const reorderedQueue: Ticket[] = arrayMove(queueTickets, oldIndex, newIndex);
          
          try {
            const movedTicketId = active.id as string;
            const newIndexInQueue = reorderedQueue.findIndex((t: Ticket) => t.id === movedTicketId);
            
            const prevTicket = newIndexInQueue === 0 ? activeTickets[0] : reorderedQueue[newIndexInQueue - 1];
            const nextTicket = reorderedQueue[newIndexInQueue + 1];
            
            const prevTime = prevTicket.createdAt?.toDate?.()?.getTime() || Date.now();
            let newTime: number;
            
            if (nextTicket) {
              const nextTime = (nextTicket as Ticket).createdAt?.toDate?.()?.getTime() || (prevTime + 2000);
              newTime = (prevTime + nextTime) / 2;
            } else {
              newTime = prevTime + 1000;
            }
            
            await updateDoc(doc(db, 'sessions', session.id, 'tickets', movedTicketId), {
              createdAt: Timestamp.fromMillis(newTime)
            });
          } catch (error) {
            console.error('Error reordering queue:', error);
          }
        };

        return (
          <main className="min-h-screen bg-gray-50 pb-12">
            {/* Header */}
            <header className="bg-primary text-white p-4 shadow-md sticky top-0 z-30">
              <div className="max-w-7xl mx-auto flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-black tracking-tighter uppercase">SmartQueue</h1>
                  <div className="flex items-center gap-1.5 px-2 py-0.5 bg-red-500 rounded text-[10px] font-bold uppercase tracking-widest animate-pulse">
                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    Live
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">
                    {userProfile?.displayName?.substring(0, 2).toUpperCase() || user?.email?.substring(0, 2).toUpperCase() || 'TA'}
                  </div>
                  <button onClick={logout} className="p-2 hover:bg-white/10 rounded-full transition-colors" aria-label="Logout">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="max-w-2xl mx-auto px-4 pt-8">
              <div className="flex items-center justify-between mb-8">
                <div className="flex flex-col gap-1">
                  <button 
                    onClick={() => setCurrentScreen('TA_DASHBOARD')}
                    className="flex items-center gap-2 text-gray-medium hover:text-primary transition-colors font-bold uppercase tracking-wider text-[10px] mb-1"
                  >
                    <ArrowLeft className="w-3 h-3" />
                    Dashboard
                  </button>
                  <h2 className="text-2xl font-bold text-dark">{session.course} — {session.time}</h2>
                </div>
                <button 
                  onClick={() => setIsEndSessionConfirmOpen(true)}
                  className="px-4 py-2 border-2 border-error text-error font-bold rounded-lg hover:bg-error/5 transition-all active:scale-95"
                >
                  End Session
                </button>
              </div>

              {/* End Session Confirmation Modal */}
              {isEndSessionConfirmOpen && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true">
                  <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 text-center">
                    <div className="w-16 h-16 bg-error/10 text-error rounded-full flex items-center justify-center mx-auto mb-6">
                      <AlertTriangle className="w-8 h-8" />
                    </div>
                    <h2 className="text-2xl font-bold text-dark mb-4">End This Session?</h2>
                    <p className="text-dark mb-4 text-lg">This will archive the session and close all remaining tickets.</p>
                    {activeTickets.length > 0 && (
                      <p className="text-error font-semibold mb-8">{activeTickets.length} student{activeTickets.length !== 1 ? 's' : ''} still in queue will lose their spot.</p>
                    )}
                    <div className="flex flex-col gap-4">
                      <button onClick={() => handleEndSession(session.id)} className="w-full px-6 py-4 bg-error text-white text-lg font-bold rounded-lg hover:bg-error/90 transition-all active:scale-95">Yes, End Session</button>
                      <button onClick={() => setIsEndSessionConfirmOpen(false)} className="w-full px-6 py-3 text-gray-medium font-semibold hover:underline rounded">Cancel — Keep Session Live</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Resolve-cluster confirmation, triggered from the Current Ticket panel */}
              {taResolveClusterTarget && (
                <ResolveClusterDialog
                  clusterLabel={taResolveClusterTarget.label}
                  memberCount={taResolveClusterTarget.memberIds.length}
                  onCancel={() => setTaResolveClusterTarget(null)}
                  onConfirm={async (explanation) => {
                    await Promise.all(
                      taResolveClusterTarget.memberIds.map(id =>
                        handleResolveTicket(session.id, id, explanation)
                      )
                    );
                    setTaResolveClusterTarget(null);
                    setTaResponse('');
                  }}
                />
              )}

              {/* View mode toggle: list vs cluster-based grouping */}
              <div className="flex items-center gap-2 mb-6">
                <span className="text-xs font-bold text-gray-medium uppercase tracking-wider">View:</span>
                <button onClick={() => setTaQueueViewMode('list')} className={`px-3 py-1.5 text-xs font-bold rounded-full transition-all ${taQueueViewMode === 'list' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-medium hover:bg-gray-200'}`}>List</button>
                <button onClick={() => setTaQueueViewMode('grouped')} className={`px-3 py-1.5 text-xs font-bold rounded-full transition-all ${taQueueViewMode === 'grouped' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-medium hover:bg-gray-200'}`}>Grouped by Topic</button>
              </div>

              <div className="space-y-8">
                {activeTickets.length > 0 && (() => {
                  // Find the cluster containing the active ticket (if any)
                  const activeTicketCluster = clusterResult?.clusters.find(
                    c => c.ticketIds.includes(activeTickets[0].id)
                  );
                  const clusterMemberIds = activeTicketCluster
                    ? activeTicketCluster.ticketIds.filter(
                        id => session.tickets.some(t => t.id === id && t.status === 'active')
                      )
                    : [];
                  const showResolveAll = clusterMemberIds.length > 1;

                  return (
                  <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                    <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-4">Current Ticket</h3>
                    <div className="bg-white rounded-2xl border-2 border-primary shadow-xl overflow-hidden">
                      <div className="p-6 border-b border-gray-100 bg-primary-light/30 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center font-bold">
                            {String.fromCharCode(65)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="font-bold text-dark text-lg">Student A</h4>
                              {activeTickets[0].attendanceMode && <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${activeTickets[0].attendanceMode === 'online' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{activeTickets[0].attendanceMode === 'online' ? 'Online' : 'In-Person'}</span>}
                              {showResolveAll && (
                                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-light text-primary">
                                  In cluster · {clusterMemberIds.length} similar
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-medium uppercase font-bold tracking-wider">{activeTickets[0].topic} • {activeTickets[0].assignment}</p>
                          </div>
                        </div>
                        <span className="text-sm font-mono text-gray-medium font-bold">#TX-{activeTickets[0].id.substring(0, 3).toUpperCase()}</span>
                      </div>
                      <div className="p-6 space-y-6">
                        <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 italic text-dark leading-relaxed">
                          "{activeTickets[0].summary}"
                        </div>
                        
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-gray-medium uppercase tracking-widest">TA Response / Explanation</label>
                          <textarea 
                            value={taResponse}
                            onChange={(e) => setTaResponse(e.target.value)}
                            placeholder="Type your explanation here... This will be saved for the student to review later."
                            className="w-full p-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all min-h-[120px] resize-none"
                          />
                        </div>

                        <div className="space-y-3">
                          <button 
                            onClick={() => {
                              handleResolveTicket(session.id, activeTickets[0].id, taResponse);
                              setTaResponse('');
                            }}
                            className="w-full py-4 bg-primary text-white font-bold rounded-xl shadow-lg hover:bg-primary-hover transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                          >
                            <CheckCircle2 className="w-5 h-5" />
                            Resolve & Complete Ticket
                          </button>
                          {showResolveAll && activeTicketCluster && (
                            <button
                              onClick={() => setTaResolveClusterTarget({
                                memberIds: clusterMemberIds,
                                label: activeTicketCluster.label,
                              })}
                              className="w-full py-3 bg-emerald-600 text-white font-bold rounded-xl shadow hover:bg-emerald-700 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                              title={`Resolve all ${clusterMemberIds.length} tickets in this cluster at once`}
                            >
                              <CheckCircle2 className="w-5 h-5" />
                              Resolve All {clusterMemberIds.length} in Cluster
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })()}

                <div className="space-y-4">
                  <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-4">Queue</h3>

                  {taQueueViewMode === 'list' ? (
                    <>
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                      >
                        <SortableContext
                          items={queueTickets.map((t: Ticket) => t.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          <div className="space-y-4">
                            {queueTickets.map((ticket: Ticket, idx: number) => (
                              <SortableTicketItem
                                key={ticket.id}
                                ticket={ticket}
                                index={idx}
                                session={session}
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>

                      {activeTickets.length === 0 && (
                        <div className="text-center py-12 bg-white rounded-2xl border-2 border-dashed border-gray-200">
                          <p className="text-gray-medium">Queue is empty.</p>
                        </div>
                      )}

                      {activeTickets.length > 1 && (
                        <div className="mt-8 p-4 bg-gray-100 rounded-lg text-center text-xs font-bold text-gray-medium uppercase tracking-widest">
                          ETAs updated for all students.
                        </div>
                      )}
                    </>
                  ) : (
                    /* Cluster view with full drag-and-drop support */
                    <ClusterDragView
                      session={session}
                      activeTickets={activeTickets}
                      clusterResult={clusterResult}
                      clustersLoading={clustersLoading}
                      sensors={sensors}
                      onMoveTicketBetweenClusters={async (ticketId, targetClusterKey, newPositionMs) => {
                        // targetClusterKey is either "noise", "cluster-<repId>", or "unpin"
                        if (targetClusterKey === 'unpin') {
                          await updateTicketPin(session.id, ticketId, null, newPositionMs);
                        } else if (targetClusterKey === 'noise') {
                          await updateTicketPin(session.id, ticketId, NOISE_PIN, newPositionMs);
                        } else if (targetClusterKey.startsWith('cluster-')) {
                          const repId = targetClusterKey.replace('cluster-', '');
                          await updateTicketPin(session.id, ticketId, repId, newPositionMs);
                        }
                      }}
                      onReorderWithinCluster={async (ticketId, newCreatedAtMs) => {
                        try {
                          await updateDoc(doc(db, 'sessions', session.id, 'tickets', ticketId), {
                            createdAt: Timestamp.fromMillis(newCreatedAtMs),
                          });
                        } catch (error) {
                          console.error('Reorder failed:', error);
                        }
                      }}
                      onMoveCluster={async (memberIds, baseCreatedAtMs) => {
                        // Rewrite all members' createdAt as a contiguous block,
                        // 100ms apart, starting at baseCreatedAtMs.
                        try {
                          for (let i = 0; i < memberIds.length; i++) {
                            await updateDoc(
                              doc(db, 'sessions', session.id, 'tickets', memberIds[i]),
                              { createdAt: Timestamp.fromMillis(baseCreatedAtMs + i * 100) }
                            );
                          }
                        } catch (error) {
                          console.error('Cluster move failed:', error);
                        }
                      }}
                      onUnpin={async (ticketId) => {
                        await updateTicketPin(session.id, ticketId, null);
                      }}
                      onMakeActive={async (ticketId) => {
                        // Set ticket's createdAt to be earlier than the current minimum,
                        // moving it to the #1 / Now slot. We also clear any pin so the
                        // clustering can flow naturally afterwards.
                        try {
                          const earliest = activeTickets.reduce((min, t) => {
                            const ms = t.createdAt?.toDate?.()?.getTime?.() ?? Date.now();
                            return ms < min ? ms : min;
                          }, Date.now());
                          await updateDoc(doc(db, 'sessions', session.id, 'tickets', ticketId), {
                            createdAt: Timestamp.fromMillis(earliest - 1000),
                          });
                        } catch (error) {
                          console.error('Make active failed:', error);
                        }
                      }}
                      onResolveTickets={async (ticketIds, explanation) => {
                        // Resolve one or many tickets with the same explanation.
                        // Used by the detail modal (single) and the Resolve All flow (many).
                        try {
                          await Promise.all(
                            ticketIds.map(id => handleResolveTicket(session.id, id, explanation))
                          );
                        } catch (error) {
                          console.error('Resolve tickets failed:', error);
                        }
                      }}
                    />
                  )}
                </div>


                {answeredTickets.length > 0 && (
                  <div className="space-y-4 pt-8 border-t border-gray-200">
                    <h3 className="text-[10px] font-bold text-gray-medium uppercase tracking-[0.2em] mb-4">Answered Tickets</h3>
                    <div className="space-y-3">
                      {answeredTickets.map((ticket: Ticket) => (
                        <div key={ticket.id} className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm flex items-center justify-between opacity-75 hover:opacity-100 transition-opacity">
                          <div className="flex items-center gap-4">
                            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                              <CheckCircle2 className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="font-bold text-dark text-sm">Student {ticket.uid.substring(0, 4).toUpperCase()}</h4>
                              <div className="flex gap-2">
                                <span className="text-[10px] font-bold text-primary uppercase">{ticket.topic}</span>
                                <span className="text-[10px] font-bold text-gray-medium uppercase">{ticket.assignment}</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] font-bold text-gray-medium uppercase block">Resolved</span>
                            <span className="text-[10px] font-bold text-emerald-600 uppercase">
                              {ticket.resolvedAt?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
        );
      }

      case 'S12':
        return (
          <main id="main-content" className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 flex flex-col items-center text-center min-h-[calc(100vh-64px)] justify-center">
            <CheckCircle2 className="w-24 h-24 text-primary mb-8" aria-hidden="true" />
            <h2 className="text-4xl font-bold text-dark mb-6">You Have Left the Queue</h2>
            <p className="text-xl text-dark mb-12 max-w-lg leading-relaxed">
              To review the questions and answers from this session, they are saved under the session archive.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
              <button 
                onClick={() => setCurrentScreen('S8')}
                className="flex-1 px-6 py-4 border-2 border-primary text-primary text-lg font-bold rounded-lg hover:bg-primary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
              >
                View Session
              </button>
              <button 
                onClick={() => setCurrentScreen('S1')}
                className="flex-1 px-6 py-4 bg-primary text-white text-lg font-bold rounded-lg shadow-md hover:bg-primary-hover hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all active:scale-95"
              >
                Back to Dashboard
              </button>
            </div>
          </main>
        );

      default:
        return <div>Screen not found</div>;
    }
  };

  return (
    <div className="min-h-screen bg-gray-light font-sans selection:bg-primary/20">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-white text-primary px-4 py-2 rounded shadow-lg z-50 font-bold outline-none ring-2 ring-primary">
        Skip to main content
      </a>
      {currentScreen !== 'LOGIN' && currentScreen !== 'REGISTER' && !currentScreen.startsWith('TA_') && <TopNav />}
      {renderScreen()}
    </div>
  );
}
