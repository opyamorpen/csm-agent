import {
  AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableOfContents,
  TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { Resvg } from '@resvg/resvg-js';
import type { CaseDraft } from './types.js';
import {
    CASE_LEGACY_SECTIONS, caseFiguresOf, caseMilestonesOf, caseSectionTexts, caseSystemUsageOf, caseV8NarrativeOf, isV8CaseDraft,
} from './cases.js';

/** docx 正文图显示宽（像素，≈页面可用宽度 @96dpi）；实际栅格化按 2x 宽渲染、transformation 减半——
 * 显示尺寸不变、像素密度翻倍（620px 直接嵌入约 100 DPI，打印/导 PDF 发糊——vision 复核结论）。 */
const DOCX_IMAGE_WIDTH = 620;
const DOCX_RASTER_SCALE = 2;

/** SVG → PNG（resvg 系统字体渲染中文）；失败返回 null——丢图不阻断导出，图注保留。 */
function svgToPng(svg: string): { data: Buffer; width: number; height: number } | null {
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: DOCX_IMAGE_WIDTH * DOCX_RASTER_SCALE },
      font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' },
      background: 'rgba(255,255,255,1)',
    });
    const rendered = resvg.render();
    // transformation 用显示尺寸（栅格尺寸/scale），Word 中物理宽度不变、清晰度 ×scale。
    return { data: rendered.asPng(), width: Math.round(rendered.width / DOCX_RASTER_SCALE), height: Math.round(rendered.height / DOCX_RASTER_SCALE) };
  } catch {
    return null;
  }
}

function textParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)], spacing: { after: 120 } });
}

function listItemParagraph(index: number, text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(`${index + 1}. ${text}`)], spacing: { after: 80 } });
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(`• ${text}`)], spacing: { after: 80 } });
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({ text, heading: level, spacing: { before: level === HeadingLevel.HEADING_1 ? 240 : 160, after: 120 } });
}

/** 章节配图：SVG 栅格化后嵌入（转换失败只保留图注段落，不阻断导出）。 */
function figureBlocks(draft: CaseDraft, section: string, kind?: string): Paragraph[] {
  const blocks: Paragraph[] = [];
  for (const figure of caseFiguresOf(draft.fields)) {
    if (figure.section !== section || (kind && figure.kind !== kind)) continue;
    const png = svgToPng(figure.svg);
    if (png) {
      blocks.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: 'png', data: png.data, transformation: { width: png.width, height: png.height } })],
        spacing: { before: 120, after: 60 },
      }));
    }
    blocks.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `图：${figure.caption}`, italics: true, size: 18, color: '666666' })],
      spacing: { after: 160 },
    }));
  }
  return blocks;
}

function systemUsageTable(rows: Array<{ item: string; content: string }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '项目', bold: true })] })], width: { size: 25, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '内容', bold: true })] })], width: { size: 75, type: WidthType.PERCENTAGE } }),
        ],
      }),
      ...rows.map((row) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(row.item)], width: { size: 25, type: WidthType.PERCENTAGE } }),
          new TableCell({ children: [new Paragraph(row.content)], width: { size: 75, type: WidthType.PERCENTAGE } }),
        ],
      })),
    ],
  });
}

/**
 * 案例草稿 → Word 文档（v8 四章深结构 / 存量旧稿五段结构，与 renderCaseMarkdown 同一内容口径）。
 * 版式：封面标题 + 目录域（打开文档时更新域生成目录）+ 中文章节标题层级 + 客户信息表 + 里程碑 + 配图。
 */
export async function renderCaseDocx(draft: CaseDraft): Promise<Buffer> {
  const children: Array<Paragraph | Table | TableOfContents> = [];
  const push = (...items: Array<Paragraph | Table | TableOfContents>) => {
    children.push(...items);
  };
  push(new Paragraph({ text: draft.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: '' }),
    new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }),
    new Paragraph({ text: '' }));
  if (isV8CaseDraft(draft.fields)) {
    const v8 = caseV8NarrativeOf(draft.fields);
    const usage = caseSystemUsageOf(draft.fields);
    const milestones = caseMilestonesOf(draft.fields);
    push(heading('一、客户及背景介绍', HeadingLevel.HEADING_1));
    push(heading('（一）客户简介', HeadingLevel.HEADING_2));
    if (v8.company_info) push(heading('公司信息', HeadingLevel.HEADING_3), textParagraph(v8.company_info));
    if (v8.business_scope) push(heading('核心业务范围', HeadingLevel.HEADING_3), textParagraph(v8.business_scope));
    if (v8.competitive_strategy) push(heading('竞争优势与发展战略', HeadingLevel.HEADING_3), textParagraph(v8.competitive_strategy));
    push(heading('（二）项目背景', HeadingLevel.HEADING_2), textParagraph(v8.project_background));
    if (usage.length) {
      push(heading('（三）系统使用情况', HeadingLevel.HEADING_2), systemUsageTable(usage), new Paragraph({ text: '' }));
    }
    push(heading('二、场景及解决方案', HeadingLevel.HEADING_1));
    push(heading('（一）业务现状', HeadingLevel.HEADING_2));
    for (const paragraph of v8.business_status) push(textParagraph(paragraph));
    push(...figureBlocks(draft, 'status'));
    push(heading('（二）业务诉求', HeadingLevel.HEADING_2));
    v8.demands.forEach((item, index) => push(listItemParagraph(index, item)));
    push(...figureBlocks(draft, 'demands'));
    push(heading('（三）业务解决方案', HeadingLevel.HEADING_2));
    v8.solution_sections.forEach((section, index) => {
      push(heading(`${index + 1}、${section.title || '方案举措'}`, HeadingLevel.HEADING_3), textParagraph(section.text));
    });
    push(...figureBlocks(draft, 'solution'));
    push(heading('三、方案价值概述', HeadingLevel.HEADING_1));
    if (milestones.length) {
      push(heading('服务里程碑', HeadingLevel.HEADING_2));
      for (const milestone of milestones) push(bulletParagraph(`${milestone.date} ${milestone.label}`));
      push(...figureBlocks(draft, 'value', 'milestone'));
    }
    push(heading('价值成效', HeadingLevel.HEADING_2));
    v8.value_items.forEach((item, index) => push(listItemParagraph(index, item)));
    if (v8.lessons.length) {
      push(heading('经验复盘与沉淀', HeadingLevel.HEADING_2));
      v8.lessons.forEach((item, index) => push(listItemParagraph(index, item)));
    }
    // value_map（痛点-方案-价值全景图）插在价值章末尾、项目总结之前，与 Markdown 渲染同位。
    push(...figureBlocks(draft, 'value', 'value_map'));
    push(heading('四、项目总结', HeadingLevel.HEADING_1), textParagraph(v8.summary));
  } else {
    const texts = caseSectionTexts(draft.fields);
    const bodies: Record<string, Array<{ index: number; text: string } | { text: string }>> = {
      background: [{ text: texts.background }],
      challenges: texts.challenges.map((text, index) => ({ index, text })),
      requirements: texts.requirements.map((text, index) => ({ index, text })),
      solution: [{ text: texts.solution }],
      value: texts.value.map((text, index) => ({ index, text })),
    };
    CASE_LEGACY_SECTIONS.forEach((section, sectionIndex) => {
      push(heading(`${['一', '二', '三', '四', '五'][sectionIndex]}、${section.label}`, HeadingLevel.HEADING_1));
      for (const item of bodies[section.key]) {
        if ('index' in item) push(listItemParagraph(item.index, item.text));
        else push(textParagraph(item.text));
      }
      push(...figureBlocks(draft, section.key));
    });
  }
  const document = new Document({
    styles: {
      default: {
        document: { run: { font: { ascii: 'Calibri', eastAsia: '宋体' }, size: 21 } },
      },
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(document);
}

/** 导出文件名（客户可读、文件系统安全；标题已含客户名时不重复前缀）。 */
export function caseDocxFilename(draft: CaseDraft, customerName?: string): string {
  const trimmedTitle = draft.title.trim();
  const prefix = customerName?.trim() && !trimmedTitle.includes(customerName.trim()) ? `${customerName.trim()} - ` : '';
  const base = `${prefix}${trimmedTitle}`.replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base || '客户成功案例'}.docx`;
}
