import React, { useState } from 'react';
import { Share2, Copy, Check, MessageCircle } from 'lucide-react';

export function ShareButton({ match }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const url = `${window.location.origin}/#/match/${match.id}`;
  const message = match.finished
    ? `🏐 ${match.teamA} ${match.sets.filter(s => s.a > s.b).length}–${match.sets.filter(s => s.b > s.a).length} ${match.teamB}\n\nResumen: ${url}`
    : `🏐 Sigue el partido EN VIVO\n${match.teamA} vs ${match.teamB}\n\n${url}`;

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
      document.body.removeChild(ta);
    }
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: `${match.teamA} vs ${match.teamB}`, text: message, url });
        setOpen(false); return;
      } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
    }
    setOpen(true);
  };

  const whatsapp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={shareNative}
        className="w-full p-4 bg-gradient-to-r from-brand-green to-brand-blue text-white rounded-2xl font-semibold flex items-center justify-center gap-2 transition shadow-card-md"
      >
        <Share2 size={18} /> Compartir partido
      </button>

      {open && (
        <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-slate-900">
              <Share2 size={20} className="text-brand-green" /> Compartir partido
            </h3>

            <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 break-all font-mono">
              {url}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={whatsapp} className="p-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-semibold flex items-center justify-center gap-2 transition">
                <MessageCircle size={18} /> WhatsApp
              </button>
              <button onClick={copyLink} className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-semibold flex items-center justify-center gap-2 transition">
                {copied ? <><Check size={18} className="text-emerald-500" /> Copiado</> : <><Copy size={18} /> Copiar</>}
              </button>
            </div>

            <p className="text-[11px] text-slate-400 text-center">
              Cualquier padre con el enlace podrá ver y editar el partido.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
