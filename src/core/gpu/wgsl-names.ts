// The WGSL names a kernel's resources and params may not take (engine.md 3.10, 3.13).

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter((w) => w.length > 0));

/** Keywords and reserved words: no identifier, struct member included, may be one. */
export const WGSL_RESERVED: ReadonlySet<string> = words(`
  alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if
  let loop override requires return struct switch true var while

  NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become cast catch class
  co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval
  constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export
  extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl
  implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move
  mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noperspective null
  nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv
  protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set
  shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this
  thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using
  varying virtual volatile wgsl where with writeonly yield
`);

/**
 * Predeclared identifiers: builtin functions, types, type generators and enumerants. A module-scope
 * declaration with one of these names shadows it for the whole module, generated code included.
 */
export const WGSL_PREDECLARED: ReadonlySet<string> = words(`
  abs acos acosh all any arrayLength asin asinh atan atan2 atanh atomicAdd atomicAnd atomicCompareExchangeWeak
  atomicExchange atomicLoad atomicMax atomicMin atomicOr atomicStore atomicSub atomicXor bitcast ceil clamp cos
  cosh countLeadingZeros countOneBits countTrailingZeros cross degrees determinant distance dot dot4I8Packed
  dot4U8Packed dpdx dpdxCoarse dpdxFine dpdy dpdyCoarse dpdyFine exp exp2 extractBits faceForward
  firstLeadingBit firstTrailingBit floor fma fract frexp fwidth fwidthCoarse fwidthFine insertBits inverseSqrt
  ldexp length log log2 max min mix modf normalize pack2x16float pack2x16snorm pack2x16unorm pack4x8snorm
  pack4x8unorm pack4xI8 pack4xI8Clamp pack4xU8 pack4xU8Clamp pow quantizeToF16 radians reflect refract
  reverseBits round saturate select sign sin sinh smoothstep sqrt step storageBarrier tan tanh textureBarrier
  textureDimensions textureGather textureGatherCompare textureLoad textureNumLayers textureNumLevels
  textureNumSamples textureSample textureSampleBaseClampToEdge textureSampleBias textureSampleCompare
  textureSampleCompareLevel textureSampleGrad textureSampleLevel textureStore transpose trunc unpack2x16float
  unpack2x16snorm unpack2x16unorm unpack4x8snorm unpack4x8unorm unpack4xI8 unpack4xU8 workgroupBarrier
  workgroupUniformLoad subgroupAdd subgroupAll subgroupAnd subgroupAny subgroupBallot subgroupBroadcast
  subgroupBroadcastFirst subgroupElect subgroupExclusiveAdd subgroupExclusiveMul subgroupInclusiveAdd
  subgroupInclusiveMul subgroupMax subgroupMin subgroupMul subgroupOr subgroupShuffle subgroupShuffleDown
  subgroupShuffleUp subgroupShuffleXor subgroupXor quadBroadcast quadSwapDiagonal quadSwapX quadSwapY

  bool f16 f32 i32 u32 array atomic ptr vec2 vec3 vec4 vec2i vec3i vec4i vec2u vec3u vec4u vec2f vec3f vec4f
  vec2h vec3h vec4h mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 mat2x2f mat2x3f mat2x4f
  mat3x2f mat3x3f mat3x4f mat4x2f mat4x3f mat4x4f mat2x2h mat2x3h mat2x4h mat3x2h mat3x3h mat3x4h mat4x2h
  mat4x3h mat4x4h sampler sampler_comparison texture_1d texture_2d texture_2d_array texture_3d texture_cube
  texture_cube_array texture_multisampled_2d texture_depth_2d texture_depth_2d_array texture_depth_cube
  texture_depth_cube_array texture_depth_multisampled_2d texture_external texture_storage_1d texture_storage_2d
  texture_storage_2d_array texture_storage_3d

  read write read_write function private workgroup uniform storage
  rgba8unorm rgba8snorm rgba8uint rgba8sint rgba16unorm rgba16snorm rgba16uint rgba16sint rgba16float
  rg8unorm rg8snorm rg8uint rg8sint rg16unorm rg16snorm rg16uint rg16sint rg16float r32uint r32sint r32float
  rg32uint rg32sint rg32float rgba32uint rgba32sint rgba32float bgra8unorm r8unorm r8snorm r8uint r8sint
  r16unorm r16snorm r16uint r16sint r16float rgb10a2unorm rgb10a2uint rg11b10ufloat
`);

/** The names the framework declares or passes that a resource would collide with (engine.md 3.13). */
export const FRAMEWORK_NAMES: ReadonlySet<string> = new Set(['frame', 'main', 'compute', 'cur', 'px', 'uv']);

/** Names generated at module scope, which author code may not declare (engine.md 3.2 rule 4). `main` and `compute` depend on the mode. */
export const GENERATED_NAMES: ReadonlySet<string> = new Set(['Frame', 'Params', 'P', 'frame', 'Out', 'Cur']);

export const NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
