import React from 'react';

function renderText(text: string): React.ReactNode {
  // Handle ==highlight== 
  const highlightParts = text.split(/(==[^=]+==)/g);
  
  return highlightParts.map((part, i) => {
    if (part.startsWith('==') && part.endsWith('==')) {
      const inner = part.slice(2, -2);
      return <span key={i} className="highlight-pill">{renderFormatting(inner)}</span>;
    }
    return <React.Fragment key={i}>{renderFormatting(part)}</React.Fragment>;
  });
}

function renderFormatting(text: string): React.ReactNode {
  // Handle **bold** and *italic*
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

const getEmojiForHeader = (text: string) => {
  const upper = text.toUpperCase();
  if (upper.includes('TRIAGE')) return '🔍';
  if (upper.includes('CHAMP')) return '📚';
  if (upper.includes('BASE RATE')) return '📊';
  if (upper.includes('PROBABILITY')) return '🎯';
  if (upper.includes('ANALYSIS')) return '🌐';
  return '⚡'; // default
};

export function Markdown({ content }: { content: string }) {
  const blocks = content.split('\n\n').filter(b => b.trim());

  return (
    <div className="markdown-content font-sans text-base leading-relaxed text-foreground">
      {blocks.map((block, i) => {
        // Headers
        if (block.startsWith('### ') || block.startsWith('## ')) {
          const text = block.replace(/^#+\s/, '');
          const emoji = getEmojiForHeader(text);
          return (
            <div key={i} className="mt-8 mb-4">
              <span className="chip-header">
                <span className="mr-2">{emoji}</span> {text}
              </span>
            </div>
          );
        }

        // Lists
        if (block.startsWith('- ') || block.startsWith('* ')) {
          const items = block.split('\n').map(line => line.replace(/^[-*]\s/, ''));
          return (
            <ul key={i} className="space-y-2 my-4">
              {items.map((item, j) => (
                <li key={j}>{renderText(item)}</li>
              ))}
            </ul>
          );
        }

        // Blockquotes
        if (block.startsWith('> ')) {
          const text = block.replace(/^>\s/gm, '');
          return (
            <blockquote key={i} className="border-l-4 border-accent pl-4 my-4 font-mono text-sm bg-muted/30 py-2 pr-4">
              {renderText(text)}
            </blockquote>
          );
        }

        // Horizontal rules
        if (block.match(/^[-*_]{3,}$/)) {
          return <hr key={i} className="my-8 border-t-2 border-black border-dashed" />;
        }

        // Paragraphs
        return (
          <p key={i} className="my-4 text-[17px]">
            {renderText(block)}
          </p>
        );
      })}
    </div>
  );
}