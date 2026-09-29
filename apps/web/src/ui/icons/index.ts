/**
 * The icon proxy.
 *
 * Every icon import in this app goes through here — never from `lucide-react` directly. The cost
 * of getting this wrong is documented and real: swapping icon libraries otherwise means editing
 * every component that draws one.
 */
export {
  Activity, AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight,
  Ban, Bell, Braces, Calendar, Check, CheckCircle2, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, Circle, Clock, Code2, Copy, Database, Download,
  Edit3, ExternalLink, Eye, EyeOff, FileText, Filter, GitBranch, Globe,
  Hash, History, Inbox, Info, Key, Layers, Link2, ListChecks, Loader2,
  Lock, LogOut, Mail, MoreHorizontal, Pause, Play, Plus, RefreshCw,
  RotateCcw, Search, Settings, Shield, SkipForward, Sparkles, Square,
  Terminal, Trash2, TrendingUp, User, Users, X, XCircle, Zap,
} from 'lucide-react';
